// Compilation/MacOSLaTeXCompiler.swift, as a compiler for macOS, Windows and Linux
import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { atomicWriteFile } from '../../electron/main/files'
import { decodeUTF8, isJSONObject, parseJSON } from './json'
import { resolvedPath } from './parser'
import {
  TranslationLanguages, checkCancellation, isCancellation,
  type CompilationArtifact, type CompilationAttempt, type LaTeXCompilerEngine, type LaTeXProjectCompiling,
  type TranslationConfiguration, type TranslationLanguage
} from './models'
import { compareStrings, newlineComponents } from './text'

export interface LaTeXProcessRequest {
  executable: string
  arguments: string[]
  workingDirectory: string
  environment?: Record<string, string | undefined>
  standardOutputPath: string
  standardErrorPath: string
}

export interface LaTeXProcessResult {
  exitCode: number
}

export interface LaTeXProcessRunning {
  run(request: LaTeXProcessRequest, signal?: AbortSignal): Promise<LaTeXProcessResult>
}

export type LaTeXCompilationErrorReason =
  | { kind: 'mainFileNotFound'; path: string }
  | { kind: 'allAttemptsFailed'; attempts: CompilationAttempt[] }

export class LaTeXCompilationError extends Error {
  constructor(readonly reason: LaTeXCompilationErrorReason) {
    super(reason.kind === 'mainFileNotFound'
      ? `No compilable main TeX file was found in ${reason.path}.`
      : `LaTeX compilation failed for all attempted engines: ${reason.attempts.map((attempt) => attempt.engine).join(', ')}.`)
    this.name = 'LaTeXCompilationError'
  }
}

/** Stops a process and everything it started: latexmk runs the engines, which run their own tools. */
function terminateTree(pid: number | undefined, kill: () => void): void {
  if (pid === undefined) return kill()
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', kill)
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    kill()
  }
}

/**
 * Runs a TeX tool without a shell, writing its output to the request's log files. A
 * cancelled run stops the whole process tree and rejects with the cancellation reason.
 */
export class NodeLaTeXProcessRunner implements LaTeXProcessRunning {
  async run(request: LaTeXProcessRequest, signal?: AbortSignal): Promise<LaTeXProcessResult> {
    checkCancellation(signal)
    const standardOutput = await open(request.standardOutputPath, 'w')
    const standardError = await open(request.standardErrorPath, 'w')
    try {
      return await new Promise<LaTeXProcessResult>((resolvePromise, reject) => {
        const child = spawn(request.executable, request.arguments, {
          cwd: request.workingDirectory,
          env: request.environment,
          shell: false,
          windowsHide: true,
          // A process group of its own, so that cancellation reaches the engines on POSIX systems.
          detached: process.platform !== 'win32',
          stdio: ['ignore', standardOutput.fd, standardError.fd]
        })
        const abort = (): void => terminateTree(child.pid, () => child.kill('SIGKILL'))
        signal?.addEventListener('abort', abort, { once: true })
        child.once('error', (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        })
        child.once('close', (code, exitSignal) => {
          signal?.removeEventListener('abort', abort)
          if (signal?.aborted) reject(signal.reason)
          else resolvePromise({ exitCode: code ?? (exitSignal ? osConstants.signals[exitSignal] ?? 1 : 1) })
        })
      })
    } finally {
      await standardOutput.close()
      await standardError.close()
    }
  }
}

export class LaTeXCompiler implements LaTeXProjectCompiling {
  private readonly runner: LaTeXProcessRunning
  private readonly engines: LaTeXCompilerEngine[]
  private readonly executable: string

  constructor(options: { runner?: LaTeXProcessRunning; engines?: LaTeXCompilerEngine[]; executable?: string } = {}) {
    this.runner = options.runner ?? new NodeLaTeXProcessRunner()
    this.engines = options.engines?.length ? options.engines : ['pdflatex', 'xelatex']
    this.executable = options.executable ?? '/usr/bin/env'
  }

  async compile(projectDirectory: string, configuration: TranslationConfiguration, signal?: AbortSignal): Promise<CompilationArtifact> {
    checkCancellation(signal)
    const mainFile = await findMainFile(projectDirectory)
    const relativeMainFile = relativePath(mainFile, projectDirectory)
    const artifactDirectory = await makeArtifactDirectory(projectDirectory)
    const mainStem = basename(mainFile, extname(mainFile))
    const attempts: CompilationAttempt[] = []

    for (const engine of this.engineOrder(configuration.targetLanguage)) {
      checkCancellation(signal)
      const attemptDirectory = join(artifactDirectory, engine)
      await mkdir(attemptDirectory, { recursive: true })
      const standardOutput = join(attemptDirectory, 'stdout.log')
      const standardError = join(attemptDirectory, 'stderr.log')
      const started = Date.now()
      let result: LaTeXProcessResult | undefined
      try {
        result = await this.runner.run({
          executable: this.executable,
          arguments: compilerArguments(engine, relativeMainFile, attemptDirectory),
          workingDirectory: projectDirectory,
          environment: { ...process.env },
          standardOutputPath: standardOutput,
          standardErrorPath: standardError
        }, signal)
      } catch (error) {
        if (isCancellation(error, signal)) throw signal?.reason ?? error
        result = undefined
        await atomicWriteFile(standardError, `${error instanceof Error ? error.message : String(error)}\n`).catch(() => undefined)
      }

      const pdfPath = join(attemptDirectory, `${mainStem}.pdf`)
      const texLog = join(attemptDirectory, `${mainStem}.log`)
      const logs = [standardOutput, standardError]
      if (await exists(texLog)) logs.push(texLog)
      const succeeded = await isUsablePDF(pdfPath, logs, result, engine)
      attempts.push({ engine, exitCode: result?.exitCode, succeeded, durationMilliseconds: Math.max(0, Date.now() - started), logPaths: logs })
      if (succeeded) return { pdfPath, logPaths: attempts.flatMap((attempt) => attempt.logPaths), attempts }
    }
    throw new LaTeXCompilationError({ kind: 'allAttemptsFailed', attempts })
  }

  /** XeLaTeX first for Simplified Chinese, LuaLaTeX first for Japanese. */
  private engineOrder(targetLanguage: TranslationLanguage): LaTeXCompilerEngine[] {
    let result = [...this.engines]
    if (targetLanguage === TranslationLanguages.simplifiedChinese && result.includes('xelatex')) {
      result = ['xelatex', ...result.filter((engine) => engine !== 'xelatex')]
    } else if (targetLanguage === TranslationLanguages.japanese) {
      result = ['lualatex', ...result.filter((engine) => engine !== 'lualatex')]
    }
    return [...new Set(result)]
  }
}

/**
 * The Swift kit's latexmk arguments, plus `-no-shell-escape`: Freddie never lets a
 * translated project run shell commands.
 */
export function compilerArguments(engine: LaTeXCompilerEngine, mainFile: string, outputDirectory: string): string[] {
  const engineFlag = engine === 'pdflatex' ? '-pdf' : engine === 'xelatex' ? '-xelatex' : '-lualatex'
  return ['latexmk', engineFlag, '-no-shell-escape', '-f', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${outputDirectory}`, mainFile]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ICU semantics: `^` and `$` (multiline) and `.` treat all of these as line terminators.
const lineTerminator = '[\\n\\v\\f\\r\\u0085\\u2028\\u2029]'
const lineStart = `(?:^|(?<=${lineTerminator}))`
const lineEnd = `(?=${lineTerminator}|$)`
const fileLineError = new RegExp(`${lineStart}\\p{White_Space}*[^\\r\\n]+\\.(?:tex|sty|cls):\\p{Nd}+:\\p{White_Space}+\\P{White_Space}`, 'u')
const fatalPhrases = [
  'fatal error occurred',
  'emergency stop',
  'no output pdf file produced',
  'undefined control sequence',
  'runaway argument',
  'file ended while scanning use of',
  'tex capacity exceeded',
  'cannot use xetexglyph'
]

export function containsFatalTeXDiagnostic(output: string): boolean {
  const normalizedOutput = output.toLowerCase()
  return fatalPhrases.some((phrase) => normalizedOutput.includes(phrase)) || fileLineError.test(output)
}

/** A latexmk report that `command` exited with a nonzero status. */
export function containsCommandFailure(command: string, output: string): boolean {
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const anyCharacter = `[^\\n\\v\\f\\r\\u0085\\u2028\\u2029]`
  const pattern = `${lineStart}\\p{White_Space}*${escapedCommand}(?:\\p{White_Space}+[^:\\r\\n]+)?:\\p{White_Space}+command for ${anyCharacter}+ gave return code\\p{White_Space}+[1-9][0-9]*\\p{White_Space}*${lineEnd}`
  return new RegExp(pattern, 'iu').test(output)
}

function containsRecoverableAuxiliaryFailure(output: string): boolean {
  return ['bibtex', 'biber', 'makeindex', 'makeglossaries'].some((command) => containsCommandFailure(command, output))
}

/**
 * A fresh nonempty PDF without a fatal TeX diagnostic, from a run that exited cleanly or failed
 * only in a bibliography or index tool.
 */
async function isUsablePDF(pdfPath: string, logs: string[], result: LaTeXProcessResult | undefined, engine: LaTeXCompilerEngine): Promise<boolean> {
  try {
    const attributes = await stat(pdfPath)
    if (!attributes.isFile() || attributes.size <= 0) return false
  } catch {
    return false
  }
  const contents: string[] = []
  for (const log of logs) {
    try {
      const text = decodeUTF8(new Uint8Array(await readFile(log)))
      if (text !== undefined) contents.push(text)
    } catch {
      // A missing log contributes nothing.
    }
  }
  const output = contents.join('\n')
  if (containsFatalTeXDiagnostic(output)) return false
  if (result === undefined) return false
  if (result.exitCode === 0) return true
  if (containsCommandFailure(engine, output)) return false
  return containsRecoverableAuxiliaryFailure(output)
}

async function projectTeXFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (folder: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.tex') files.push(path)
    }
  }
  await visit(directory)
  return files
}

/** The `00README.json` top-level file, or the first TeX file (by path) with a `\documentclass`. */
async function findMainFile(directory: string): Promise<string> {
  try {
    const metadata = parseJSON(decodeUTF8(new Uint8Array(await readFile(join(directory, '00README.json')))) ?? '')
    const sources = isJSONObject(metadata) ? metadata.sources : undefined
    const valid = Array.isArray(sources) && sources.every((source) => isJSONObject(source)
      && typeof source.filename === 'string'
      && (source.usage === undefined || source.usage === null || typeof source.usage === 'string'))
    const filename = valid ? (sources as Array<{ filename: string; usage?: string | null }>).find((source) => source.usage === 'toplevel')?.filename : undefined
    if (filename !== undefined) {
      const candidate = resolve(directory, filename)
      if (isWithin(candidate, directory) && await exists(candidate)) return candidate
    }
  } catch {
    // No usable metadata.
  }

  const files = (await projectTeXFiles(directory)).sort((a, b) => compareStrings(relativePath(a, directory), relativePath(b, directory)))
  for (const file of files) {
    let source: string | undefined
    try {
      source = decodeUTF8(new Uint8Array(await readFile(file)))
    } catch {
      continue
    }
    if (source === undefined) continue
    const uncommented = newlineComponents(source).map((line) => {
      const percent = line.indexOf('%')
      if (percent < 0 || (percent !== 0 && line[percent - 1] === '\\')) return line
      return line.slice(0, percent)
    }).join('\n')
    if (/\\document(?:class|style)(?:\[[^\]]*\])?\{[^{}]+\}/.test(uncommented)) return file
  }
  throw new LaTeXCompilationError({ kind: 'mainFileNotFound', path: directory })
}

async function makeArtifactDirectory(projectDirectory: string): Promise<string> {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(projectDirectory, suffix === 0 ? 'compilation' : `compilation_${suffix}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** Relative with "/" separators, or the full path outside `directory`. */
function relativePath(path: string, directory: string): string {
  const root = resolve(directory)
  const target = resolve(path)
  if (!target.startsWith(root + sep)) return target
  return relative(root, target).split(sep).join('/')
}

function isWithin(path: string, directory: string): boolean {
  return resolvedPath(path).startsWith(resolvedPath(directory) + sep)
}
