// The Swift LaTeXTransKit test suites and read-paper's LaTeXTranslationServiceTests, ported:
// the behaviors that need injected collaborators rather than recorded fixtures.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryTranslationCheckpointStore, LaTeXCompilationError, LaTeXCompiler, LaTeXParserError, LaTeXTranslationPipeline, NodeLaTeXProcessRunner,
  ProjectPreparationError, PromptingLaTeXTranslator, RoutedProjectPreparer, ArXivProjectPreparer, SecureArchiveProjectPreparer,
  StructuralLaTeXValidator, TranslationPipelineError, compilerArguments, containsCommandFailure, containsFatalTeXDiagnostic,
  partiallyTranslatedUnitCode, translationConfiguration, translationContext, untranslatedUnitCode, validationIssue,
  type CompilationAttempt, type LaTeXProcessRequest, type LaTeXProcessResult, type LaTeXProcessRunning, type LaTeXProjectCompiling,
  type LaTeXPromptCompleting, type LaTeXPromptRequest, type LaTeXUnit, type LaTeXUnitTranslating, type ParsedLaTeXProject,
  type TranslatedLaTeXUnit, type TranslationArchiveEntry, type TranslationArchiveReading, type TranslationContext
} from '../LaTeXTransKit/src'
import {
  EngineCompatibilityPreamblePolicy, FileLaTeXTranslationCheckpointStore, FreddieLaTeXPromptClient, LaTeXTranslationService,
  LiteralPercentPreservingLaTeXParser, ToolchainProcessRunner, errorMessage, incompleteUnitCount, indicatesMissingLatexmk,
  latexTranslationDirectory, normalizeEngineSpecificSource, normalizeProject, preferredLogPath, progressUpdate, resolvingArxivIdentifier,
  terminologyEntries, translationCacheIdentity, type LaTeXProgressUpdate
} from '../LaTeXTransKit'
import type { ResolvedRoute } from '../electron/main/llm'
import { createTranslator } from '../shared/i18n'

const t = createTranslator('en')
let temporary: string
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'latextrans-kit-'))
})
afterEach(() => rmSync(temporary, { recursive: true, force: true }))

const route = (overrides: Partial<ResolvedRoute> = {}): ResolvedRoute => ({
  providerId: 'provider', providerName: 'Provider', modelId: 'model', modelName: 'test-model',
  baseURL: 'https://llm.example.com/v1', apiStyle: 'chat-completions', apiKey: 'sk-must-not-be-persisted', ...overrides
})

function slotSources(request: LaTeXPromptRequest): Array<{ id: string; source: string }> {
  const user = request.messages[request.messages.length - 1].content
  const line = user.split('[Translation slots JSON]\n')[1]?.split('\n')[0] ?? '[]'
  return JSON.parse(line) as Array<{ id: string; source: string }>
}

/** Translates every slot by prefixing it, as read-paper's SlotTranslatingLLMProvider does. */
class SlotTranslatingClient implements LaTeXPromptCompleting {
  readonly requests: LaTeXPromptRequest[] = []
  async complete(request: LaTeXPromptRequest): Promise<string> {
    this.requests.push(request)
    if (request.purpose.kind === 'summary') return 'A summary.'
    return JSON.stringify(slotSources(request).map((slot) => ({ id: slot.id, translation: `译${slot.source}` })))
  }
}

// MARK: Pipeline

const stubPreparer = { prepare: async () => ({ identifier: 'stub', sourceDirectory: '/tmp/source', workspaceDirectory: '/tmp/workspace' }) }
const stubParser = (units: LaTeXUnit[]) => ({ parse: async (): Promise<ParsedLaTeXProject> => ({ mainFile: '/tmp/source/main.tex', units, inputs: [], environments: [], captions: [], newCommands: [], sections: [] }) })
const stubReconstructor = { reconstruct: async () => '/tmp/workspace/output' }
const unit = (id: string, source: string, shouldTranslate = true): LaTeXUnit => ({ id, kind: 'section', source, shouldTranslate })

class RetryTranslator implements LaTeXUnitTranslating {
  readonly contexts: TranslationContext[] = []
  async translate(units: LaTeXUnit[], context: TranslationContext): Promise<TranslatedLaTeXUnit[]> {
    this.contexts.push(context)
    return units.map((item) => ({
      id: item.id, kind: item.kind, source: item.source, completeness: 'complete',
      translation: context.attempt === 0 ? '\\section{介绍} 你好' : '\\section{介绍} 你好 <PLACEHOLDER_ENV_1>'
    }))
  }
}

describe('LaTeX translation pipeline', () => {
  it('retries only the units that failed validation', async () => {
    const units = [unit('section-1', '\\section{Intro} Hello <PLACEHOLDER_ENV_1>'), { ...unit('equation-1', '\\begin{equation}x=1\\end{equation}', false), kind: 'environment' as const }]
    const translator = new RetryTranslator()
    const pipeline = new LaTeXTranslationPipeline({ preparer: stubPreparer, parser: stubParser(units), translator, validator: new StructuralLaTeXValidator(), reconstructor: stubReconstructor })
    const artifact = await pipeline.run({ source: { kind: 'localDirectory', path: '/tmp/source' }, workspaceDirectory: '/tmp/workspace', configuration: translationConfiguration({ maximumValidationRetries: 1 }) })
    expect(artifact.units.map((item) => item.id)).toEqual(['section-1', 'equation-1'])
    expect(artifact.units[0].translation).toContain('<PLACEHOLDER_ENV_1>')
    expect(artifact.units[1].translation).toBe(units[1].source)
    expect(artifact.validationIssues).toEqual([])
    expect(translator.contexts.map((context) => context.attempt)).toEqual([0, 1])
    expect(translator.contexts[1].previousTranslations.map((item) => item.id)).toEqual(['section-1'])
    expect(translator.contexts[1].previousTranslations[0].translation).toBe('\\section{介绍} 你好')
  })

  it('reports incomplete units as warnings without failing the run', async () => {
    const units = ['complete', 'partial', 'untranslated'].map((id) => unit(id, `Source text for ${id}.`))
    const translator: LaTeXUnitTranslating = {
      translate: async (items) => items.map((item) => ({ id: item.id, kind: item.kind, source: item.source, translation: item.source, completeness: item.id as TranslatedLaTeXUnit['completeness'] }))
    }
    const pipeline = new LaTeXTranslationPipeline({ preparer: stubPreparer, parser: stubParser(units), translator, validator: new StructuralLaTeXValidator(), reconstructor: stubReconstructor })
    const artifact = await pipeline.run({ source: { kind: 'localDirectory', path: '/tmp/source' }, workspaceDirectory: '/tmp/workspace', configuration: translationConfiguration() })
    expect(artifact.validationIssues.map((issue) => issue.unitID)).toEqual(['partial', 'untranslated'])
    expect(artifact.validationIssues.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(artifact.validationIssues.map((issue) => issue.code)).toEqual([partiallyTranslatedUnitCode, untranslatedUnitCode])
  })

  it('requires an injected compiler for PDF output', async () => {
    const pipeline = new LaTeXTranslationPipeline({ preparer: stubPreparer, parser: stubParser([]), translator: new RetryTranslator(), validator: new StructuralLaTeXValidator(), reconstructor: stubReconstructor })
    await expect(pipeline.run({ source: { kind: 'localDirectory', path: '/tmp/source' }, workspaceDirectory: '/tmp/workspace', configuration: translationConfiguration({ compilationPolicy: 'pdfRequired' }) }))
      .rejects.toSatisfy((error: unknown) => error instanceof TranslationPipelineError && error.reason.kind === 'missingCompiler')
  })

  it('rejects duplicate parser identifiers before translating', async () => {
    const translator = new RetryTranslator()
    const pipeline = new LaTeXTranslationPipeline({ preparer: stubPreparer, parser: stubParser([unit('duplicate', 'one'), { ...unit('duplicate', 'two'), kind: 'caption' }]), translator, validator: new StructuralLaTeXValidator(), reconstructor: stubReconstructor })
    await expect(pipeline.run({ source: { kind: 'localDirectory', path: '/tmp/source' }, workspaceDirectory: '/tmp/workspace', configuration: translationConfiguration() }))
      .rejects.toSatisfy((error: unknown) => error instanceof TranslationPipelineError && error.reason.kind === 'invalidProject')
    expect(translator.contexts).toEqual([])
  })

  it('rejects a translator that returns another unit set', async () => {
    const translator: LaTeXUnitTranslating = { translate: async (items) => [...items, ...items].map((item) => ({ ...item, translation: item.source, completeness: 'complete' })) }
    const pipeline = new LaTeXTranslationPipeline({ preparer: stubPreparer, parser: stubParser([unit('a', 'Text.')]), translator, validator: new StructuralLaTeXValidator(), reconstructor: stubReconstructor })
    await expect(pipeline.run({ source: { kind: 'localDirectory', path: '/tmp/source' }, workspaceDirectory: '/tmp/workspace', configuration: translationConfiguration() }))
      .rejects.toThrow('The translator returned an invalid unit set. Expected ["a"], received ["a"].')
  })
})

// MARK: Translator runtime

describe('Prompting LaTeX translator', () => {
  const context = translationContext({ sourceLanguage: 'en', targetLanguage: 'zh-Hans', attempt: 0, maximumConcurrentTranslations: 3 })

  it('bounds concurrency and returns parser order', async () => {
    let active = 0
    let maximum = 0
    const client: LaTeXPromptCompleting = {
      async complete(request) {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, request.purpose.kind === 'translation' && request.purpose.unitID.endsWith('0') ? 30 : 5))
        active -= 1
        return JSON.stringify(slotSources(request).map((slot) => ({ id: slot.id, translation: `译${slot.source}` })))
      }
    }
    const units = Array.from({ length: 10 }, (_, index) => unit(`section:${index}`, `Paragraph number ${index} has words.`))
    const translated = await new PromptingLaTeXTranslator({ client }).translate(units, context)
    expect(translated.map((item) => item.id)).toEqual(units.map((item) => item.id))
    expect(maximum).toBe(3)
    expect(translated[0].translation).toBe('译Paragraph number 0 has words.')
  })

  it('reuses completed checkpoints without calling the model again', async () => {
    const client = new SlotTranslatingClient()
    const store = new InMemoryTranslationCheckpointStore()
    const translator = new PromptingLaTeXTranslator({ client, checkpointStore: store })
    const units = [unit('section:1', 'A paragraph to translate once.')]
    const first = await translator.translate(units, context)
    const second = await translator.translate(units, context)
    expect(second).toEqual(first)
    expect(client.requests).toHaveLength(1)
    expect(store.storedTranslationCount()).toBe(1)
  })

  it('stops a batch on cancellation without checkpointing pending responses', async () => {
    const controller = new AbortController()
    const store = new InMemoryTranslationCheckpointStore()
    let calls = 0
    const client: LaTeXPromptCompleting = {
      async complete(request, signal) {
        calls += 1
        if (calls === 2) controller.abort(new DOMException('cancelled', 'AbortError'))
        await new Promise((resolve) => setTimeout(resolve, 5))
        signal?.throwIfAborted()
        return JSON.stringify(slotSources(request).map((slot) => ({ id: slot.id, translation: `译${slot.source}` })))
      }
    }
    const units = Array.from({ length: 4 }, (_, index) => unit(`section:${index}`, `Paragraph ${index} has prose.`))
    await expect(new PromptingLaTeXTranslator({ client, checkpointStore: store }).translate(units, { ...context, maximumConcurrentTranslations: 1 }, controller.signal))
      .rejects.toSatisfy((error: unknown) => error instanceof DOMException && error.name === 'AbortError')
    expect(store.storedTranslationCount()).toBe(1)
  })

  it('fails the batch when one unit fails and waits for the others', async () => {
    let finished = 0
    const client: LaTeXPromptCompleting = {
      async complete(request, signal) {
        if (request.purpose.kind === 'translation' && request.purpose.unitID === 'section:1') throw new Error('network down')
        await new Promise((resolve) => setTimeout(resolve, 10))
        finished += 1
        signal?.throwIfAborted()
        return '[]'
      }
    }
    const units = [unit('section:0', 'First paragraph text.'), unit('section:1', 'Second paragraph text.'), unit('section:2', 'Third paragraph text.')]
    await expect(new PromptingLaTeXTranslator({ client }).translate(units, context)).rejects.toThrow('network down')
    expect(finished).toBeGreaterThan(0)
  })
})

// MARK: Compiler

interface Step { exitCode: number; producesPDF: boolean; texLog?: string; standardOutput?: string }

class ScriptedProcessRunner implements LaTeXProcessRunning {
  readonly arguments: string[][] = []
  constructor(private readonly steps: Step[]) {}
  async run(request: LaTeXProcessRequest): Promise<LaTeXProcessResult> {
    this.arguments.push(request.arguments)
    const step = this.steps.shift()!
    writeFileSync(request.standardOutputPath, step.standardOutput ?? 'stdout')
    writeFileSync(request.standardErrorPath, 'stderr')
    if (step.producesPDF) {
      const output = request.arguments.find((argument) => argument.startsWith('-outdir='))!.slice('-outdir='.length)
      const stem = request.arguments[request.arguments.length - 1].replace(/\.tex$/, '')
      writeFileSync(join(output, `${stem}.pdf`), 'pdf')
      if (step.texLog) writeFileSync(join(output, `${stem}.log`), step.texLog)
    }
    return { exitCode: step.exitCode }
  }
}

describe('LaTeX compiler', () => {
  const project = (): string => {
    writeFileSync(join(temporary, 'main.tex'), '\\documentclass{article}\\begin{document}Text\\end{document}')
    return temporary
  }

  it('falls back across engines with structured logs', async () => {
    const runner = new ScriptedProcessRunner([{ exitCode: 1, producesPDF: false }, { exitCode: 0, producesPDF: true }])
    const artifact = await new LaTeXCompiler({ runner }).compile(project(), translationConfiguration({ targetLanguage: 'en', compilationPolicy: 'pdfRequired' }))
    expect(artifact.attempts.map((attempt) => attempt.engine)).toEqual(['pdflatex', 'xelatex'])
    expect(artifact.attempts.map((attempt) => attempt.succeeded)).toEqual([false, true])
    expect(artifact.attempts.map((attempt) => attempt.exitCode)).toEqual([1, 0])
    expect(existsSync(artifact.pdfPath)).toBe(true)
    expect(artifact.logPaths).toHaveLength(4)
    expect(artifact.logPaths.every((path) => existsSync(path))).toBe(true)
  })

  it('treats a clean exit without a PDF as a failed attempt', async () => {
    const compiler = new LaTeXCompiler({ runner: new ScriptedProcessRunner([{ exitCode: 0, producesPDF: false }]), engines: ['pdflatex'] })
    const error = await compiler.compile(project(), translationConfiguration()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LaTeXCompilationError)
    const attempts = (error as LaTeXCompilationError).reason.kind === 'allAttemptsFailed' ? ((error as LaTeXCompilationError).reason as { attempts: CompilationAttempt[] }).attempts : []
    expect(attempts.map((attempt) => [attempt.exitCode, attempt.succeeded])).toEqual([[0, false]])
  })

  it('keeps a usable PDF after a recoverable bibliography failure', async () => {
    const runner = new ScriptedProcessRunner([{
      exitCode: 12,
      producesPDF: true,
      standardOutput: "Latexmk: Errors, in force_mode: so I tried finishing targets\nCollected error summary (may duplicate other messages):\n  bibtex main: Command for 'bibtex main' gave return code 12"
    }])
    const artifact = await new LaTeXCompiler({ runner, engines: ['xelatex'] }).compile(project(), translationConfiguration())
    expect(artifact.attempts.map((attempt) => [attempt.exitCode, attempt.succeeded])).toEqual([[12, true]])
    expect(runner.arguments[0]).toContain('-f')
  })

  it('rejects a partial PDF from a failed engine before falling back', async () => {
    const runner = new ScriptedProcessRunner([
      {
        exitCode: 12,
        producesPDF: true,
        texLog: './sections/introduction.tex:27: Cannot use XeTeXglyph with ptmr8c; not a native platform font.',
        standardOutput: "Latexmk: Errors, in force_mode: so I tried finishing targets\nCollected error summary (may duplicate other messages):\n  xelatex: Command for 'xelatex' gave return code 1"
      },
      { exitCode: 0, producesPDF: true }
    ])
    const artifact = await new LaTeXCompiler({ runner, engines: ['xelatex', 'lualatex'] }).compile(project(), translationConfiguration({ targetLanguage: 'zh-Hans' }))
    expect(artifact.attempts.map((attempt) => [attempt.engine, attempt.succeeded])).toEqual([['xelatex', false], ['lualatex', true]])
    expect(dirname(artifact.pdfPath).split(sep).pop()).toBe('lualatex')
  })

  it('rejects a PDF that comes with a fatal TeX log', async () => {
    const runner = new ScriptedProcessRunner([{ exitCode: 1, producesPDF: true, texLog: 'Fatal error occurred, no output PDF file produced!' }])
    await expect(new LaTeXCompiler({ runner, engines: ['xelatex'] }).compile(project(), translationConfiguration())).rejects.toBeInstanceOf(LaTeXCompilationError)
  })

  it('orders engines by target language', async () => {
    const japanese = new ScriptedProcessRunner([{ exitCode: 0, producesPDF: true }])
    expect((await new LaTeXCompiler({ runner: japanese }).compile(project(), translationConfiguration({ targetLanguage: 'ja' }))).attempts.map((attempt) => attempt.engine)).toEqual(['lualatex'])
    expect(japanese.arguments[0]).toContain('-lualatex')
    const chinese = new ScriptedProcessRunner([{ exitCode: 0, producesPDF: true }])
    expect((await new LaTeXCompiler({ runner: chinese }).compile(project(), translationConfiguration({ targetLanguage: 'zh-Hans' }))).attempts.map((attempt) => attempt.engine)).toEqual(['xelatex'])
    expect(chinese.arguments[0]).toEqual(['latexmk', '-xelatex', '-no-shell-escape', '-f', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${join(temporary, 'compilation_1', 'xelatex')}`, 'main.tex'])
  })

  it('recognizes fatal diagnostics and command failures as latexmk reports them, with CRLF line ends', () => {
    expect(containsFatalTeXDiagnostic('! Undefined control sequence.')).toBe(true)
    expect(containsFatalTeXDiagnostic('C:\\paper\\main.tex:12: LaTeX Error: File `x.sty\' not found.')).toBe(true)
    expect(containsFatalTeXDiagnostic('Output written on main.pdf (3 pages).')).toBe(false)
    expect(containsCommandFailure('bibtex', "Collected error summary:\r\n  bibtex main: Command for 'bibtex main' gave return code 2\r\n")).toBe(true)
    expect(containsCommandFailure('xelatex', "  BibTeX: Command for 'bibtex' gave return code 2")).toBe(false)
    expect(compilerArguments('pdflatex', 'main.tex', 'out')).toContain('-pdf')
  })

  it('stops a running process tree when cancelled', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const run = new NodeLaTeXProcessRunner().run({
      executable: process.execPath,
      arguments: ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setTimeout(() => {}, 20000)"],
      workingDirectory: temporary,
      environment: { ...process.env },
      standardOutputPath: join(temporary, 'stdout.log'),
      standardErrorPath: join(temporary, 'stderr.log')
    }, controller.signal)
    setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 300)
    await expect(run).rejects.toSatisfy((error: unknown) => error instanceof DOMException && error.name === 'AbortError')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

// MARK: Preparation

class EntriesReader implements TranslationArchiveReading {
  constructor(private readonly items: TranslationArchiveEntry[]) {}
  async *entries(): AsyncGenerator<TranslationArchiveEntry> {
    yield* this.items
  }
}

const file = (path: string, text: string): TranslationArchiveEntry => ({ path, kind: 'regularFile', uncompressedSize: Buffer.byteLength(text), contents: new TextEncoder().encode(text) })

describe('Secure project preparation', () => {
  it('extracts entries below an isolated project folder', async () => {
    writeFileSync(join(temporary, 'paper.tar.gz'), '')
    const prepared = await new SecureArchiveProjectPreparer(new EntriesReader([{ path: 'sections', kind: 'directory', uncompressedSize: 0, contents: new Uint8Array() }, file('main.tex', '\\documentclass{article}'), file('sections/a.tex', 'A')]))
      .prepare({ source: { kind: 'localArchive', path: join(temporary, 'paper.tar.gz') }, workspaceDirectory: join(temporary, 'workspace'), configuration: translationConfiguration() })
    expect(prepared.identifier).toBe('paper')
    expect(prepared.sourceDirectory).toBe(join(temporary, 'workspace', 'prepared', 'paper'))
    expect(readFileSync(join(prepared.sourceDirectory, 'sections', 'a.tex'), 'utf8')).toBe('A')
  })

  it('rejects traversal, links and oversized expansion and removes partial output', async () => {
    writeFileSync(join(temporary, 'paper.zip'), '')
    const prepare = (items: TranslationArchiveEntry[], limits = {}) => new SecureArchiveProjectPreparer(new EntriesReader(items), limits)
      .prepare({ source: { kind: 'localArchive', path: join(temporary, 'paper.zip') }, workspaceDirectory: join(temporary, 'workspace'), configuration: translationConfiguration() })
    const reason = async (promise: Promise<unknown>): Promise<string | undefined> => {
      const error = await promise.catch((caught: unknown) => caught)
      return error instanceof ProjectPreparationError ? error.reason.kind : undefined
    }
    expect(await reason(prepare([file('main.tex', 'x'), file('../escape.tex', 'x')]))).toBe('unsafeArchiveEntry')
    expect(await reason(prepare([file('C:\\escape.tex', 'x')]))).toBe('unsafeArchiveEntry')
    expect(await reason(prepare([{ path: 'link', kind: 'symbolicLink', uncompressedSize: 0, contents: new Uint8Array() }]))).toBe('unsupportedArchiveEntry')
    expect(await reason(prepare([file('a.tex', 'xxxx'), file('b.tex', 'yyyy')], { maximumTotalSize: 6 }))).toBe('archiveLimitExceeded')
    expect(await reason(prepare([]))).toBe('emptyArchive')
    expect(readdirSync(join(temporary, 'workspace', 'prepared'))).toEqual([])
  })

  it('keeps arXiv acquisition with the host and validates identifiers', async () => {
    const project = join(temporary, 'acquired')
    mkdirSync(project)
    const acquired: string[] = []
    const preparer = new RoutedProjectPreparer({ arXiv: new ArXivProjectPreparer({ acquireProject: async (identifier) => { acquired.push(identifier); return { kind: 'localDirectory', path: project } } }) })
    const prepared = await preparer.prepare({ source: { kind: 'arxiv', identifier: '2401.00001v2' }, workspaceDirectory: temporary, configuration: translationConfiguration() })
    expect(prepared).toEqual({ identifier: '2401.00001v2', sourceDirectory: project, workspaceDirectory: temporary })
    expect(acquired).toEqual(['2401.00001v2'])
    await expect(preparer.prepare({ source: { kind: 'arxiv', identifier: '../etc' }, workspaceDirectory: temporary, configuration: translationConfiguration() })).rejects.toBeInstanceOf(ProjectPreparationError)
  })
})

// MARK: Host

describe('Freddie LaTeX translation host', () => {
  it('maps the route and prompt onto the provider request without storing the key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: ' translated ' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      const client = new FreddieLaTeXPromptClient(route({ temperature: 0.35, topP: 0.8, maxTokens: 777, thinkingMode: 'enabled', reasoningEffort: 'high' }), t)
      const result = await client.complete({ purpose: { kind: 'translation', unitID: 'section-0', unitKind: 'section', attempt: 0 }, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'source' }], temperature: 0.7, maximumOutputTokens: 8_192 })
      expect(result).toBe('translated')
      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ model: 'test-model', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'source' }], temperature: 0.35, top_p: 0.8, max_tokens: 777, reasoning_effort: 'high' })
      const defaults = new FreddieLaTeXPromptClient(route(), t)
      await defaults.complete({ purpose: { kind: 'summary' }, messages: [{ role: 'user', content: 'x' }], temperature: 0.2, maximumOutputTokens: 1_024 })
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ temperature: 0.2, max_tokens: 1_024 })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('counts incomplete units from completeness warnings only', () => {
    expect(incompleteUnitCount([
      validationIssue({ unitID: 'a', severity: 'warning', code: untranslatedUnitCode, message: '' }),
      validationIssue({ unitID: 'b', severity: 'warning', code: partiallyTranslatedUnitCode, message: '' }),
      validationIssue({ unitID: 'c', severity: 'error', code: 'placeholder-mismatch', message: '' })
    ])).toBe(2)
    expect(incompleteUnitCount([])).toBe(0)
  })

  it('maps pipeline events onto monotonic progress', () => {
    const updates = [
      { stage: 'preparing' }, { stage: 'parsing' },
      { stage: 'translating', completedUnitCount: 0, totalUnitCount: 4 }, { stage: 'translating', completedUnitCount: 2, totalUnitCount: 4 }, { stage: 'translating', completedUnitCount: 4, totalUnitCount: 4 },
      { stage: 'validating' }, { stage: 'reconstructing' }, { stage: 'compiling' }, { stage: 'finished' }
    ].map((event) => progressUpdate(event as Parameters<typeof progressUpdate>[0]))
    expect(updates[updates.length - 1].fractionCompleted).toBe(1)
    expect(updates.every((update, index) => index === 0 || updates[index - 1].fractionCompleted <= update.fractionCompleted)).toBe(true)
    expect([updates[3].completedUnits, updates[3].totalUnits]).toEqual([2, 4])
  })

  it('persists checkpoints atomically and reads them back', async () => {
    const path = join(temporary, 'nested', 'checkpoints.json')
    const store = new FileLaTeXTranslationCheckpointStore(path)
    await Promise.all([store.saveTranslation('译文', 'section-0', 'abc'), store.saveTranslation('其他', 'section-1', 'def')])
    const restored = new FileLaTeXTranslationCheckpointStore(path)
    expect(await restored.translation('section-0', 'abc')).toBe('译文')
    expect(await restored.translation('section-1', 'def')).toBe('其他')
    expect(readFileSync(path, 'utf8')).toBe('{"section-0\\u001fabc":"译文","section-1\\u001fdef":"其他"}')
  })

  it('keys workspaces like native Freddie', () => {
    const identity = translationCacheIdentity({ modelName: 'gpt', apiStyle: 'responses', temperature: 1, topP: 0.5, maxTokens: 100, thinkingMode: undefined, reasoningEffort: 'high' })
    expect(identity).toBe('model=gpt|api=responses|temperature=1.0|topP=0.5|maxTokens=100|thinking=default|reasoning=high|prompt=academic-v3')
    const hash = createHash('sha256').update('identity').digest('hex').slice(0, 16)
    expect(latexTranslationDirectory(join(temporary, 'X'), 'zh-CN', 'identity')).toBe(join(temporary, 'X', 'translations', 'latex', 'zh-CN', hash))
    expect(latexTranslationDirectory(join(temporary, 'X'), 'zh/CN.1', 'identity')).toBe(join(temporary, 'X', 'translations', 'latex', 'zh_CN_1', hash))
  })

  it('translates source end to end under the paper folder, with host rewrites and no stored key', async () => {
    const project = join(temporary, 'input')
    mkdirSync(project)
    writeFileSync(join(project, 'main.tex'), [
      '\\documentclass{legacy_template}', '\\pdfoutput=1', '\\pdfsuppresswarningpagegroup=1', '\\usepackage[latin9]{inputenc}', '\\begin{document}', '\\section{Introduction}',
      'This deterministic fixture contains enough academic prose to become a translatable section. It describes a method, its experimental setting, its measured outcomes, and its limitations while preserving every LaTeX command exactly for the host integration test.',
      '\\end{document}'
    ].join('\n'))
    writeFileSync(join(project, 'legacy_template.cls'), ['\\NeedsTeXFormat{LaTeX2e}', '\\ProvidesClass{legacy_template}', '\\LoadClass{article}', '\\pdfoutput=1', '\\RequirePackage{microtype}', '\\DisableLigatures[f]{family=sf*}', '\\pdfmapline{+customfont < customfont.ttf}'].join('\n'))
    const paperDirectory = join(temporary, 'Library', 'paper')
    const progress: LaTeXProgressUpdate[] = []
    const output = await new LaTeXTranslationService({ t, acquirer: { acquireProject: async () => ({ kind: 'localDirectory', path: project }) }, client: () => new SlotTranslatingClient() })
      .translate({ paperDirectory, arxivIdentifier: '2401.00001v1', targetLanguage: 'zh-CN', maximumConcurrency: 2, glossary: 'method => 方法', documentSummary: 'A deterministic integration fixture.', route: route() }, (update) => progress.push(update))
    expect(output.artifact.projectDirectory.startsWith(join(paperDirectory, 'translations', 'latex') + sep)).toBe(true)
    expect(output.artifact.pdfPath).toBeUndefined()
    expect(output.pdfCompilationFailed).toBe(false)
    expect(incompleteUnitCount(output.artifact.validationIssues)).toBe(0)
    const main = readFileSync(join(output.artifact.projectDirectory, 'main.tex'), 'utf8')
    expect(main).toContain('\\usepackage[UTF8,fontset=fandol]{ctex}')
    expect(main).toContain('\\ifdefined\\pdfoutput\\pdfoutput=1\\fi')
    expect(main).toContain('\\ifdefined\\pdfsuppresswarningpagegroup\\pdfsuppresswarningpagegroup=1\\fi')
    expect(main).toContain('\\ifdefined\\pdftexversion\\usepackage[utf8]{inputenc}\\fi')
    const translatedClass = readFileSync(join(output.artifact.projectDirectory, 'legacy_template.cls'), 'utf8')
    expect(translatedClass).toContain('\\ifdefined\\pdfoutput\\pdfoutput=1\\fi')
    expect(translatedClass).toContain('\\ifdefined\\pdftexversion\\DisableLigatures[f]{family=sf*}\\fi')
    expect(translatedClass).toContain('\\ifdefined\\pdfmapline\\pdfmapline{+customfont < customfont.ttf}\\fi')
    const files: string[] = []
    const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) entry.isDirectory() ? visit(join(folder, entry.name)) : files.push(join(folder, entry.name)) }
    visit(paperDirectory)
    expect(files.some((path) => path.endsWith('checkpoints.json'))).toBe(true)
    expect(files.some((path) => readFileSync(path, 'utf8').includes('sk-must-not-be-persisted'))).toBe(false)
    expect(progress[progress.length - 1].stage).toBe('finished')
  })

  const sourceProject = (text: string): string => {
    const project = join(temporary, 'input')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'main.tex'), text)
    return project
  }

  it('returns the translated source and the attempts when compilation fails', async () => {
    const project = sourceProject('\\documentclass{article}\n\\begin{document}\n\\section{Results}\nThis fixture contains enough prose to exercise translation before an injected compiler failure.\n\\end{document}\n')
    const attempt: CompilationAttempt = { engine: 'xelatex', exitCode: 1, succeeded: false, durationMilliseconds: 12, logPaths: [join(temporary, 'xelatex.stderr.log')] }
    const compiler: LaTeXProjectCompiling = { compile: async () => { throw new LaTeXCompilationError({ kind: 'allAttemptsFailed', attempts: [attempt] }) } }
    const output = await new LaTeXTranslationService({ t, compiler, acquirer: { acquireProject: async () => ({ kind: 'localDirectory', path: project }) }, client: () => new SlotTranslatingClient() })
      .translate({ paperDirectory: join(temporary, 'paper'), arxivIdentifier: '2401.00002v1', targetLanguage: 'zh-CN', maximumConcurrency: 1, glossary: '', documentSummary: 'A compiler-failure fixture.', route: route() }, () => {})
    expect(output.pdfCompilationFailed).toBe(true)
    expect(output.artifact.pdfPath).toBeUndefined()
    expect(output.failedCompilationAttempts).toEqual([attempt])
    expect(existsSync(join(output.artifact.projectDirectory, 'main.tex'))).toBe(true)
  })

  it('retries a frozen minted cache failure in draft mode without corrupting code', async () => {
    const project = sourceProject([
      '\\documentclass{article}', '\\usepackage[frozencache,cachedir=_minted]{minted}', '\\begin{document}', '\\section{Implementation}',
      'This deterministic section contains enough academic prose to exercise the translation pipeline while a frozen minted cache reports that its generated highlighting is stale.',
      '\\begin{minted}{python}', 'if layer_number % (block_size // 2) == 0:', '    print("boundary")', '\\end{minted}', '\\end{document}'
    ].join('\n'))
    let invocations = 0
    const compiler: LaTeXProjectCompiling = {
      async compile(directory) {
        invocations += 1
        if (invocations === 1) {
          const log = join(directory, 'frozen.log')
          writeFileSync(log, 'Package minted Error: Cannot highlight code (frozencache=true)')
          throw new LaTeXCompilationError({ kind: 'allAttemptsFailed', attempts: [{ engine: 'xelatex', exitCode: 1, succeeded: false, durationMilliseconds: 1, logPaths: [log] }] })
        }
        const pdfPath = join(directory, 'main.pdf')
        writeFileSync(pdfPath, 'pdf')
        return { pdfPath, logPaths: [], attempts: [] }
      }
    }
    const output = await new LaTeXTranslationService({ t, compiler, acquirer: { acquireProject: async () => ({ kind: 'localDirectory', path: project }) }, client: () => new SlotTranslatingClient() })
      .translate({ paperDirectory: join(temporary, 'paper'), arxivIdentifier: '2401.00003v1', targetLanguage: 'zh-CN', maximumConcurrency: 1, glossary: '', documentSummary: 'A frozen minted cache fixture.', route: route() }, () => {})
    expect(output.pdfCompilationFailed).toBe(false)
    expect(output.artifact.pdfPath).toBeDefined()
    expect(invocations).toBe(2)
    const main = readFileSync(join(output.artifact.projectDirectory, 'main.tex'), 'utf8')
    expect(main).toContain('\\usepackage[draft,cachedir=_minted]{minted}')
    expect(main).toContain('layer_number % (block_size // 2)')
  })

  it('runs the chosen latexmk directly, first on PATH, with paranoid TeX file access', async () => {
    const recorded: LaTeXProcessRequest[] = []
    const latexmk = join(temporary, 'texbin', process.platform === 'win32' ? 'latexmk.exe' : 'latexmk')
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    await new ToolchainProcessRunner(latexmk, { run: async (request) => { recorded.push(request); return { exitCode: 0 } } }).run({
      executable: '/usr/bin/env', arguments: ['latexmk', '-xelatex', 'main.tex'], workingDirectory: temporary,
      environment: { [pathKey]: ['/usr/bin', '/bin'].join(delimiter) }, standardOutputPath: join(temporary, 'stdout.log'), standardErrorPath: join(temporary, 'stderr.log')
    })
    expect(recorded[0].executable).toBe(latexmk)
    expect(recorded[0].arguments).toEqual(['-xelatex', 'main.tex'])
    expect(recorded[0].environment?.[pathKey]).toBe([dirname(latexmk), '/usr/bin', '/bin'].join(delimiter))
    expect(Object.keys(recorded[0].environment ?? {}).filter((key) => key.toUpperCase() === 'PATH')).toEqual([pathKey])
    expect(recorded[0].environment).toMatchObject({ openin_any: 'p', openout_any: 'p', shell_escape: 'f' })
  })

  it('prefers a nonempty stderr log and recognizes a missing latexmk', async () => {
    const stdout = join(temporary, 'stdout.log')
    const stderr = join(temporary, 'stderr.log')
    writeFileSync(stdout, '')
    writeFileSync(stderr, 'env: latexmk: No such file or directory\n')
    const attempt: CompilationAttempt = { engine: 'xelatex', exitCode: 127, succeeded: false, durationMilliseconds: 4, logPaths: [stdout, stderr] }
    expect(await preferredLogPath([attempt])).toBe(stderr)
    expect(await indicatesMissingLatexmk([attempt])).toBe(true)
  })

  it('parses glossary terminology and ignores notes', () => {
    expect(terminologyEntries('model => 模型\nloss = 损失\noptimizer\t优化器\nkeep this as a note')).toEqual([
      { source: 'model', target: '模型' }, { source: 'loss', target: '损失' }, { source: 'optimizer', target: '优化器' }
    ])
  })

  it('guards pdfTeX-only source idempotently', () => {
    const source = ['\\documentclass{article}', '\\pdfoutput=1', '\\pdfsuppresswarningpagegroup = 1 % source compatibility', '\\usepackage[latin9]{inputenc}', '% \\pdfoutput=0', '\\begin{document}Text\\end{document}'].join('\n')
    const policy = new EngineCompatibilityPreamblePolicy()
    const transformed = policy.transform(source, 'zh-Hans')
    expect(transformed).toContain('\\ifdefined\\pdfoutput\\pdfoutput=1\\fi')
    expect(transformed).toContain('\\ifdefined\\pdfsuppresswarningpagegroup\\pdfsuppresswarningpagegroup=1\\fi % source compatibility')
    expect(transformed).toContain('\\ifdefined\\pdftexversion\\usepackage[utf8]{inputenc}\\fi')
    expect(transformed).toContain('% \\pdfoutput=0')
    expect(policy.transform(transformed, 'zh-Hans')).toBe(transformed)
    const repaired = normalizeEngineSpecificSource('\\providecommand{\\chinese}{}n\\renewcommand{\\chinese}[1]{{#1}}')
    expect(repaired).toBe('\\providecommand{\\chinese}{}\n\\renewcommand{\\chinese}[1]{{#1}}')
    expect(normalizeEngineSpecificSource(repaired)).toBe(repaired)
  })

  it('keeps literal percent signs inside minted while parsing and restores them', async () => {
    const original = ['\\documentclass{article}', '% This ordinary TeX comment should still be removed by the parser.', '\\begin{document}', '\\begin{figure}', '\\begin{minted}{python}', 'if layer_number % (block_size // 2) == 0:', '    print("100% boundary")', '\\end{minted}', '\\caption{Code sample.}', '\\end{figure}', '\\end{document}'].join('\n')
    writeFileSync(join(temporary, 'main.tex'), original)
    const marker = 'READPAPERLITERALPERCENTTEST'
    const parsed = await new LiteralPercentPreservingLaTeXParser(marker).parse({ identifier: 'minted-percent', sourceDirectory: temporary, workspaceDirectory: temporary })
    const figure = parsed.environments.find((environment) => environment.env_name === 'figure')!
    expect(figure.content).toContain(`layer_number ${marker} (block_size // 2)`)
    expect(figure.content).toContain(`100${marker} boundary`)
    expect(figure.content).not.toContain('ordinary TeX comment')
    expect(readFileSync(join(temporary, 'main.tex'), 'utf8')).toBe(original)
    writeFileSync(join(temporary, 'reconstructed.tex'), figure.content)
    await normalizeProject(temporary, marker)
    expect(readFileSync(join(temporary, 'reconstructed.tex'), 'utf8')).toContain('layer_number % (block_size // 2)')
  })

  it('resolves arXiv versions without duplicating them', () => {
    expect(resolvingArxivIdentifier('2401.00001', 'v2')).toBe('2401.00001v2')
    expect(resolvingArxivIdentifier('2401.00001v2', 'v2')).toBe('2401.00001v2')
    expect(resolvingArxivIdentifier('hep-th/9901001', '3')).toBe('hep-th/9901001v3')
  })

  it('localizes the kit failures', () => {
    expect(errorMessage(new LaTeXParserError({ kind: 'mainFileNotFound', projectDirectory: '/private/source' }), t)).toBe('Error: Could not parse the LaTeX source.')
    expect(errorMessage(new TranslationPipelineError({ kind: 'validationFailed', issues: [] }), t)).toBe('Error: The LaTeX translation failed structural validation.')
    expect(errorMessage(new TranslationPipelineError({ kind: 'validationFailed', issues: [
      validationIssue({ unitID: 'section:9', severity: 'error', code: 'placeholder-mismatch', message: 'Missing a placeholder.' }),
      validationIssue({ unitID: 'section:6_2', severity: 'error', code: 'command-mismatch', message: 'Changed a command.' })
    ] }), t)).toBe('Error: The LaTeX translation failed structural validation: section:6_2 [command-mismatch]; section:9 [placeholder-mismatch]')
    expect(errorMessage(new Error('Network is down.'), t)).toBe('Network is down.')
  })
})
