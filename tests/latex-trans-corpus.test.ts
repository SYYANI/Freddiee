// Replays real arXiv sources through the host composition, with the parity generator's
// scripted model, and compares every stage with hashes recorded from the Swift kit
// (tests/fixtures/latex-trans/corpus.json). The archives come from a native Freddie library
// (or LATEX_TRANS_CORPUS); without them the test is skipped.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ArXivProjectPreparer, AutomaticTranslationArchiveReader, LaTeXTranslationPipeline, PromptLaTeXDocumentSummarizer, PromptingLaTeXTranslator,
  RoutedProjectPreparer, StructuralLaTeXValidator, StructuredLaTeXReconstructor, translationConfiguration
} from '../LaTeXTransKit/src'
import { EngineCompatibilityPreamblePolicy, LiteralPercentPreservingLaTeXParser, normalizeProject, terminologyEntries } from '../LaTeXTransKit'
import { RecordingCheckpoints, ScriptedClient, digest, tree, type Entry } from './latex-trans-support'

const corpus = process.env.LATEX_TRANS_CORPUS ?? join(homedir(), 'Library', 'Application Support', 'ReadPaper', 'Library')
const expected = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'latex-trans', 'corpus.json'), 'utf8')) as Entry[]

/** Source archives that native Freddie downloaded: `<paper>/translations/latex/<target>/<identity>/downloads/*.tar`. */
function archives(): Map<string, string> {
  const found = new Map<string, string>()
  if (!existsSync(corpus)) return found
  const visit = (folder: string, depth: number): void => {
    if (depth > 7) return
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) visit(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.tar') && path.includes(join('translations', 'latex')) && !found.has(entry.name)) found.set(entry.name, path)
    }
  }
  visit(corpus, 0)
  return found
}

const available = archives()
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'latextrans-corpus-')))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe.skipIf(!available.size)('LaTeXTransKit on real arXiv sources', () => {
  for (const entry of expected) {
    const archive = available.get(entry.archive)
    const matches = archive !== undefined && createHash('sha256').update(readFileSync(archive)).digest('hex') === entry.sha256
    it.skipIf(!matches)(`reproduces ${entry.archive}`, async () => {
      const identifier = entry.archive.replace(/\.tar$/, '')
      const workspace = join(work, identifier)
      const client = new ScriptedClient()
      const store = new RecordingCheckpoints()
      const marker = 'READPAPERLITERALPERCENTFIXTURE'
      const pipeline = new LaTeXTranslationPipeline({
        preparer: new RoutedProjectPreparer({
          arXiv: new ArXivProjectPreparer({ acquireProject: async () => ({ kind: 'localArchive', path: archive! }) }, new AutomaticTranslationArchiveReader())
        }),
        parser: new LiteralPercentPreservingLaTeXParser(marker),
        translator: new PromptingLaTeXTranslator({ client, summarizer: new PromptLaTeXDocumentSummarizer(client), checkpointStore: store, collationLocale: 'en-US' }),
        validator: new StructuralLaTeXValidator(),
        reconstructor: new StructuredLaTeXReconstructor({ preamblePolicy: new EngineCompatibilityPreamblePolicy() })
      })
      const configuration = translationConfiguration({
        sourceLanguage: 'en', targetLanguage: 'zh-Hans', maximumValidationRetries: 3, compilationPolicy: 'sourceOnly',
        validationFailurePolicy: 'fail', maximumConcurrentTranslations: 1, previousContextUnitCount: 1,
        terminology: terminologyEntries('model => 模型\nlanguage model => 语言模型'), documentSummary: 'Configured abstract.'
      })
      const events: Entry[] = []
      const artifact = await pipeline.run({ source: { kind: 'arxiv', identifier }, workspaceDirectory: workspace, configuration }, (event) => {
        events.push({ stage: event.stage, completedUnitCount: event.completedUnitCount ?? null, totalUnitCount: event.totalUnitCount ?? null, detail: event.detail ?? null })
      })
      await normalizeProject(artifact.projectDirectory, marker)
      expect(entry.error).toBeUndefined()
      expect(digest(tree(join(workspace, 'prepared', identifier))), 'prepared source').toBe(entry.prepared)
      expect(client.calls.length, 'model calls').toBe(entry.callCount)
      expect(digest(client.calls), 'model calls').toBe(entry.calls)
      expect(digest(store.operations), 'checkpoints').toBe(entry.checkpoints)
      expect(artifact.units.length).toBe(entry.unitCount)
      expect(digest(artifact.units), 'translated units').toBe(entry.units)
      expect(digest(artifact.validationIssues), 'validation issues').toBe(entry.issues)
      expect(digest(events), 'events').toBe(entry.events)
      expect(digest(tree(artifact.projectDirectory)), 'reconstructed project').toBe(entry.output)
    }, 120_000)
  }
})
