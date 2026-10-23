// Replays tests/fixtures/latex-trans/parity.json, recorded from the Swift LaTeXTransKit by
// scripts/latex-trans-parity: the TypeScript port must produce the same parse maps, prompts
// (and so checkpoint fingerprints), model-call sequence, translations, validation issues,
// reconstructed projects, archive entries and host rewrites.
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AutomaticTranslationArchiveReader, LaTeXTranslationPipeline, LocalDirectoryProjectPreparer, PromptLaTeXDocumentSummarizer,
  PromptingLaTeXTranslator, ReferenceLanguagePreamblePolicy, SecureArchiveProjectPreparer, StructuralLaTeXValidator, StructuredLaTeXParser,
  StructuredLaTeXReconstructor, normalizeTranslationBoundary, tokenize, translationConfiguration, translationContext,
  type LaTeXUnit, type ParsedLaTeXProject, type TranslationContext
} from '../LaTeXTransKit/src'
import {
  EngineCompatibilityPreamblePolicy, LiteralPercentPreservingLaTeXParser, normalizeEngineSpecificSource, normalizeProject,
  normalizedGlossary, progressUpdate, protectingLiteralPercents, replacingFrozenMintedCacheOption, resolvingArxivIdentifier,
  terminologyEntries
} from '../LaTeXTransKit'
import { RecordingCheckpoints, ReplayClient, tree, type Entry } from './latex-trans-support'

const fixtureDirectory = join(__dirname, 'fixtures', 'latex-trans')
const fixtures = JSON.parse(readFileSync(join(fixtureDirectory, 'parity.json'), 'utf8')) as Record<string, any>
const section = (name: string): Entry[] => fixtures[name] as Entry[]

/** The generator runs with `-AppleLocale en_US`, which fixes how glossary entries are ordered. */
const collationLocale = 'en-US'

const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'latextrans-parity-')))
afterAll(() => rmSync(work, { recursive: true, force: true }))
let copies = 0

function copyProject(name: string): string {
  copies += 1
  const destination = join(work, 'sources', `${copies}`, name)
  cpSync(join(fixtureDirectory, 'projects', name), destination, { recursive: true })
  return destination
}

const normalized = (message: string, root?: string): string => {
  let result = message
  for (const [path, name] of [[root, '<root>'], [fixtureDirectory, '<fixtures>'], [work, '<work>']] as const) {
    if (path) result = result.split(realpathSync.native(path)).join(name).split(path).join(name)
  }
  return result
}

const errorJSON = (error: unknown, root?: string): Entry => ({
  type: error instanceof Error ? error.name : typeof error,
  message: normalized(error instanceof Error ? error.message : String(error), root)
})

function parsedJSON(parsed: ParsedLaTeXProject, root: string): Entry {
  const rootPath = realpathSync.native(root)
  const main = realpathSync.native(parsed.mainFile)
  return {
    mainFile: main.startsWith(rootPath + sep) ? main.slice(rootPath.length + 1).split(sep).join('/') : main,
    units: parsed.units,
    inputs: parsed.inputs,
    environments: parsed.environments,
    captions: parsed.captions,
    newCommands: parsed.newCommands,
    sections: parsed.sections
  }
}

const contextFrom = (value: Entry): TranslationContext => translationContext({
  sourceLanguage: value.sourceLanguage,
  targetLanguage: value.targetLanguage,
  attempt: value.attempt,
  validationIssues: value.validationIssues,
  previousTranslations: value.previousTranslations,
  terminology: value.terminology,
  documentSummary: value.documentSummary ?? undefined,
  maximumConcurrentTranslations: value.maximumConcurrentTranslations,
  previousContextUnitCount: value.previousContextUnitCount
})

describe('LaTeXTransKit parity with the Swift kit', () => {
  it('parses every project into the same maps, or fails the same way', async () => {
    for (const entry of section('parser')) {
      const root = copyProject(entry.name)
      try {
        const parsed = await new StructuredLaTeXParser().parse({ identifier: entry.name, sourceDirectory: root, workspaceDirectory: work })
        expect(entry.error, entry.name).toBeUndefined()
        expect(parsedJSON(parsed, root), entry.name).toEqual(entry.parsed)
      } catch (error) {
        expect(entry.error, `${entry.name}: ${String(error)}`).toBeDefined()
        expect(errorJSON(error, realpathSync.native(root)), entry.name).toEqual(entry.error)
      }
    }
  })

  it('tokenizes structure identically', () => {
    for (const entry of section('tokenizer')) expect(tokenize(entry.text), entry.text).toEqual(entry.tokens)
  })

  it('sends the same prompts, renders the same translations and keeps the same checkpoints', async () => {
    for (const scenario of section('translation')) {
      const client = new ReplayClient(scenario.calls)
      const store = new RecordingCheckpoints(scenario.initialCheckpoints)
      const translator = new PromptingLaTeXTranslator({
        client,
        summarizer: scenario.summarizer ? new PromptLaTeXDocumentSummarizer(client) : undefined,
        checkpointStore: store,
        maximumResponseAttempts: scenario.maximumResponseAttempts,
        collationLocale
      })
      let result: unknown
      try {
        result = await translator.translate(scenario.units as LaTeXUnit[], contextFrom(scenario.context))
      } catch (error) {
        result = { error: errorJSON(error) }
      }
      expect(result, scenario.name).toEqual(scenario.result)
      expect(store.operations, scenario.name).toEqual(scenario.checkpointOperations)
      client.finish()
    }
  })

  it('reports the same validation issues', async () => {
    for (const [index, entry] of section('validation').entries()) {
      const id = `pair:${index}`
      const issues = await new StructuralLaTeXValidator().validate(
        [{ id, kind: 'section', source: entry.source, shouldTranslate: true }],
        [{ id, kind: 'section', source: entry.source, translation: entry.translation, completeness: 'complete' }]
      )
      expect(issues, entry.translation).toEqual(entry.issues)
    }
  })

  it('applies the same language preambles and control-word boundaries', () => {
    for (const entry of section('preamble')) {
      expect(new ReferenceLanguagePreamblePolicy().transform(entry.source, entry.language), `${entry.language}: ${entry.source}`).toBe(entry.output)
    }
    for (const entry of section('boundary')) expect(`${normalizeTranslationBoundary(entry.input)}\n`).toBe(entry.output)
  })

  it('runs whole pipelines to the same reconstructed projects', async () => {
    const marker = 'READPAPERLITERALPERCENTFIXTURE'
    for (const entry of section('pipelines')) {
      const label = `${entry.name} ${entry.language}${entry.host ? ' host' : ''}`
      const root = copyProject(entry.name)
      const workspace = join(work, 'workspaces', `${copies}`)
      const client = new ReplayClient(entry.calls)
      const store = new RecordingCheckpoints()
      const pipeline = new LaTeXTranslationPipeline({
        preparer: new LocalDirectoryProjectPreparer(),
        parser: entry.host ? new LiteralPercentPreservingLaTeXParser(marker) : new StructuredLaTeXParser(),
        translator: new PromptingLaTeXTranslator({ client, summarizer: new PromptLaTeXDocumentSummarizer(client), checkpointStore: store, collationLocale }),
        validator: new StructuralLaTeXValidator(),
        reconstructor: new StructuredLaTeXReconstructor({ preamblePolicy: entry.host ? new EngineCompatibilityPreamblePolicy() : new ReferenceLanguagePreamblePolicy() })
      })
      const configuration = translationConfiguration({
        sourceLanguage: 'en',
        targetLanguage: entry.language,
        maximumValidationRetries: 3,
        compilationPolicy: 'sourceOnly',
        validationFailurePolicy: 'continueWithIssues',
        maximumConcurrentTranslations: 1,
        previousContextUnitCount: 1,
        terminology: entry.terminology,
        documentSummary: entry.documentSummary ?? undefined
      })
      const events: Entry[] = []
      try {
        const artifact = await pipeline.run({ source: { kind: 'localDirectory', path: root }, workspaceDirectory: workspace, configuration }, (event) => {
          events.push({ stage: event.stage, completedUnitCount: event.completedUnitCount ?? null, totalUnitCount: event.totalUnitCount ?? null, detail: event.detail ?? null })
        })
        if (entry.host) await normalizeProject(artifact.projectDirectory, marker)
        expect(entry.error, label).toBeUndefined()
        expect(relative(realpathSync.native(workspace), realpathSync.native(artifact.projectDirectory)).split(sep).join('/'), label).toBe(entry.projectDirectory)
        expect(artifact.units, label).toEqual(entry.units)
        expect(artifact.validationIssues, label).toEqual(entry.validationIssues)
        expect(tree(artifact.projectDirectory), label).toEqual(entry.output)
        expect(tree(root), `${label} source`).toEqual(entry.source)
      } catch (error) {
        expect(entry.error, `${label}: ${String(error)}`).toBeDefined()
        expect(errorJSON(error, realpathSync.native(root)), label).toEqual(entry.error)
      }
      expect(events, label).toEqual(entry.events)
      expect(store.operations, label).toEqual(entry.checkpointOperations)
      client.finish()
    }
  })

  it('reads and extracts archives identically', async () => {
    for (const entry of section('archives')) {
      const path = join(fixtureDirectory, 'archives', entry.name)
      try {
        const entries: Entry[] = []
        for await (const item of new AutomaticTranslationArchiveReader().entries(path)) {
          entries.push({ path: item.path, kind: item.kind, uncompressedSize: item.uncompressedSize, sha256: createHash('sha256').update(item.contents).digest('hex'), size: item.contents.length })
        }
        expect(entry.entriesError, entry.name).toBeUndefined()
        expect(entries, entry.name).toEqual(entry.entries)
      } catch (error) {
        expect(entry.entriesError, `${entry.name}: ${String(error)}`).toBeDefined()
        expect(errorJSON(error), entry.name).toEqual(entry.entriesError)
      }
      copies += 1
      const workspace = join(work, 'archives', `${copies}`)
      try {
        const prepared = await new SecureArchiveProjectPreparer(new AutomaticTranslationArchiveReader()).prepare({ source: { kind: 'localArchive', path }, workspaceDirectory: workspace, configuration: translationConfiguration() })
        expect(entry.preparedError, entry.name).toBeUndefined()
        expect({
          identifier: prepared.identifier,
          directory: relative(workspace, prepared.sourceDirectory).split(sep).join('/'),
          files: tree(prepared.sourceDirectory)
        }, entry.name).toEqual(entry.prepared)
      } catch (error) {
        expect(entry.preparedError, `${entry.name}: ${String(error)}`).toBeDefined()
        expect(errorJSON(error), entry.name).toEqual(entry.preparedError)
        expect(tree(workspace), entry.name).toEqual(entry.preparedLeftovers)
      }
    }
  })

  it('ports the host rewrites, glossary parsing, identifiers and progress weights', () => {
    const host = fixtures.host as Record<string, Entry[]>
    for (const entry of host.glossary) {
      expect(normalizedGlossary(entry.input)).toBe(entry.normalized)
      expect(terminologyEntries(entry.input)).toEqual(entry.terminology)
    }
    for (const entry of host.identifiers) expect(resolvingArxivIdentifier(entry.id, entry.version ?? undefined), entry.id).toBe(entry.resolved)
    for (const entry of host.engine) {
      expect(normalizeEngineSpecificSource(entry.source), entry.source).toBe(entry.normalized)
      expect(replacingFrozenMintedCacheOption(entry.source), entry.source).toBe(entry.minted)
      expect(protectingLiteralPercents(entry.source, 'MARK'), entry.source).toBe(entry.percent)
      expect(new EngineCompatibilityPreamblePolicy().transform(entry.source, 'zh-Hans'), entry.source).toBe(entry.policy)
    }
    for (const entry of host.progress) {
      const update = progressUpdate({ stage: entry.stage, completedUnitCount: entry.completedUnitCount ?? undefined, totalUnitCount: entry.totalUnitCount ?? undefined })
      expect(update.fractionCompleted, entry.stage).toBeCloseTo(entry.fractionCompleted, 12)
    }
  })
})
