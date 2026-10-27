import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Translator } from '../../shared/i18n'
import {
  ArXivProjectPreparer,
  AutomaticTranslationArchiveReader,
  FreddieArXivProjectAcquirer,
  RoutedProjectPreparer,
  StructuredLaTeXParser,
  resolvingArxivIdentifier,
  translationConfiguration,
  type ParsedLaTeXProject
} from '../../LaTeXTransKit'
import {
  semanticHintsSchemaVersion,
  validateSemanticDocument,
  type BabelDocSemanticBlock,
  type BabelDocSemanticBlockKind,
  type BabelDocSemanticDocument
} from '../../BabelDocKit'
import { atomicWriteFile } from './files'

const extractorVersion = 1

function semanticCacheKey(identifier: string): string {
  return createHash('sha256')
    .update(`schema=${semanticHintsSchemaVersion}|extractor=${extractorVersion}|source=${identifier}`)
    .digest('hex').slice(0, 24)
}

/** Outline reading must never initiate source acquisition or model requests. */
export async function cachedBabelDocSemanticHints(paperDirectory: string, arxivIdentifier: string, arxivVersion?: string): Promise<BabelDocSemanticDocument | null> {
  const identifier = resolvingArxivIdentifier(arxivIdentifier, arxivVersion)
  const root = join(paperDirectory, 'translations', 'babeldoc', 'semantic')
  try {
    const cached = JSON.parse(await readFile(join(root, `semantic-${semanticCacheKey(identifier)}.json`), 'utf8')) as BabelDocSemanticDocument
    validateSemanticDocument(cached)
    if (cached.sourceIdentifier === identifier) return cached
  } catch { /* Also recognize validated sidecars copied by native-library import. */ }
  const nativeKey = createHash('sha256').update(`schema=1|extractor=3|source=${identifier}`).digest('hex').slice(0, 24)
  const nativeRoot = join(paperDirectory, 'Resources', 'LaTeXSemantic')
  try {
    const data = await readFile(join(nativeRoot, `semantic-${nativeKey}.json`))
    const metadata = JSON.parse(await readFile(join(nativeRoot, `semantic-${nativeKey}.metadata.json`), 'utf8'))
    if (metadata.cacheSchemaVersion !== 1 || metadata.extractorAlgorithmVersion !== 3 || metadata.sourceIdentifier !== identifier ||
      metadata.semanticSHA256 !== createHash('sha256').update(data).digest('hex')) return null
    const cached = JSON.parse(data.toString('utf8')) as BabelDocSemanticDocument
    validateSemanticDocument(cached)
    return cached.sourceIdentifier === identifier ? cached : null
  } catch { return null }
}

export interface BabelDocSemanticHintOptions {
  paperDirectory: string
  arxivIdentifier: string
  arxivVersion?: string
  signal: AbortSignal
  t: Translator
  onStatus: (message: string) => void
}

/**
 * Builds a compiler-free semantic sidecar from the already ported secure arXiv
 * preparation and structured LaTeX parser. Hints are optional: acquisition or
 * parsing failures return null and BabelDOC continues from PDF layout alone.
 */
export async function prepareBabelDocSemanticHints(options: BabelDocSemanticHintOptions): Promise<BabelDocSemanticDocument | null> {
  const { paperDirectory, signal, t, onStatus } = options
  const identifier = resolvingArxivIdentifier(options.arxivIdentifier, options.arxivVersion)
  const key = semanticCacheKey(identifier)
  const root = join(paperDirectory, 'translations', 'babeldoc', 'semantic')
  const cachePath = join(root, `semantic-${key}.json`)
  onStatus(t('Checking cached arXiv structure...'))
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as BabelDocSemanticDocument
    validateSemanticDocument(cached)
    if (cached.sourceIdentifier === identifier) {
      onStatus(t('Using cached LaTeX structure to improve PDF translation.'))
      return cached
    }
  } catch {
    // Rebuild absent or corrupt sidecars.
  }

  const workspace = join(root, 'workspaces', key)
  try {
    signal.throwIfAborted()
    await rm(workspace, { recursive: true, force: true })
    await mkdir(workspace, { recursive: true })
    onStatus(t('Downloading arXiv LaTeX source...'))
    const preparer = new RoutedProjectPreparer({
      arXiv: new ArXivProjectPreparer(
        new FreddieArXivProjectAcquirer(t),
        new AutomaticTranslationArchiveReader()
      )
    })
    const prepared = await preparer.prepare({
      source: { kind: 'arxiv', identifier },
      workspaceDirectory: workspace,
      configuration: translationConfiguration({ compilationPolicy: 'sourceOnly' })
    }, signal)
    onStatus(t('Extracting LaTeX structure for PDF translation...'))
    const parsed = await new StructuredLaTeXParser({ minimumSectionTokenCount: 0 }).parse(prepared, signal)
    const document = semanticDocumentFromParsedProject(parsed, identifier)
    validateSemanticDocument(document)
    await atomicWriteFile(cachePath, `${JSON.stringify(document, null, 2)}\n`)
    onStatus(t('LaTeX structure is ready for PDF translation.'))
    return document
  } catch (error) {
    if (signal.aborted) throw error
    onStatus(t('LaTeX source is unavailable; continuing with PDF layout analysis.'))
    return null
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Converts parser units into conservative, alignable prose blocks. */
export function semanticDocumentFromParsedProject(parsed: ParsedLaTeXProject, sourceIdentifier: string): BabelDocSemanticDocument {
  const blocks: BabelDocSemanticBlock[] = []
  let ordinal = 0
  let sectionPath: Array<{ level: number; title: string }> = []
  const append = (kind: BabelDocSemanticBlockKind, rawSource: string, environment?: string, headingLevel?: number): void => {
    const alignmentText = latexVisibleText(rawSource)
    if (alignmentText.length < 3) return
    blocks.push({
      id: `latex-${ordinal}`,
      ordinal,
      kind,
      alignmentText,
      translationTemplate: alignmentText,
      rawSource,
      sectionPath: [...sectionPath],
      environment: environment ?? null,
      ...(headingLevel === undefined ? {} : { headingLevel }),
      atoms: []
    })
    ordinal += 1
  }

  const allSource = parsed.units.map((unit) => unit.source).join('\n')
  const title = /\\title\s*\{([^{}]+)\}/s.exec(allSource)?.[1]
  if (title) append('documentTitle', title)

  for (const unit of parsed.units) {
    if (!unit.shouldTranslate) continue
    const environment = unit.kind === 'environment'
      ? parsed.environments.find((item) => unit.id.endsWith(item.placeholder))?.env_name
      : undefined
    const heading = /\\(section|subsection|subsubsection|paragraph)\*?\s*\{([^{}]+)\}/s.exec(unit.source)
    if (heading) {
      const level = heading[1] === 'section' ? 1 : heading[1] === 'subsection' ? 2 : heading[1] === 'subsubsection' ? 3 : 4
      const headingText = latexVisibleText(heading[2])
      sectionPath = [...sectionPath.filter((entry) => entry.level < level), { level, title: headingText }]
      append('sectionHeading', heading[2], undefined, level)
    }
    const kind: BabelDocSemanticBlockKind = unit.kind === 'caption'
      ? 'caption'
      : environment === 'abstract'
        ? 'abstract'
        : environment === 'proof'
          ? 'proof'
          : environment && /theorem|lemma|proposition|corollary/i.test(environment)
            ? 'theorem'
            : 'paragraph'
    for (const paragraph of unit.source.split(/\n\s*\n+/)) append(kind, paragraph, environment)
  }
  return { schemaVersion: semanticHintsSchemaVersion, sourceIdentifier, blocks }
}

function latexVisibleText(source: string): string {
  let text = source
    .replace(/%[^\n]*/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\\begin\s*\{[^{}]+\}|\\end\s*\{[^{}]+\}/g, ' ')
    .replace(/<PLACEHOLDER_[A-Z_]+_\d+>/g, ' ')
  for (let pass = 0; pass < 4; pass += 1) {
    text = text.replace(/\\(?:textbf|textit|emph|textrm|textsf|texttt|underline|mbox)\*?(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, '$1')
  }
  return text
    .replace(/\\(?:cite\w*|ref|eqref|label|url|href)\*?(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, ' ')
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/\\([#$%&_{}])/g, '$1')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
