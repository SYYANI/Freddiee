import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { atomicWriteFile } from '../../electron/main/files'
import { LatexError } from './errors'
import type { PageLayout } from './geometry'
import { lineContexts, frameWidth, type LineMode } from './lineBreaks'
import type { PageMarkup } from './markup'
import { Pattern, PythonText, parseDouble, parseInt10 } from './pattern'
import {
  type LineRange, ParagraphSizes, type PlacedFigures, type TranslationTypography, alignmentEnd, buildTeX, untagDisplays
} from './texSource'

/** The outcome of compiling one page. */
export interface CompileResult {
  pdf: string
  pages: number
  naturalHeight: number
  textHeight: number
  overfull: number[]
  /** Widest overflow of each overfull paragraph, keyed by its main.tex line range, in log order. */
  paragraphs: Array<{ range: LineRange; overflow: number }>
  /** Overflow of each displayed formula wider than its column, keyed by its \[ ... \] line range. */
  displays: Array<{ range: LineRange; overflow: number }>
  scale: number
  paragraphSizes: ParagraphSizes
  longLines: string[]
  bodyHeight: number
  /** Depth of the body's first material below the top of the text area. */
  bodyStart: number
  /** The layout the page was set in, its text area extended over every figure. */
  layout?: PageLayout
  /** How far the vertical gaps of the markup were narrowed to fit the page. */
  spaceScale: number
}

/** Runs XeLaTeX on one page's main.tex. */
export interface TeXCompiling {
  /** Compiles `main.tex` in `directory`; returns the exit status and the console output. */
  compile(directory: string): Promise<{ status: number; output: string }>
}

/** The system XeLaTeX, sandboxed to the build directory. */
export class XeLaTeXCompiler implements TeXCompiling {
  constructor(readonly executable: string, readonly options: { timeoutMs?: number; signal?: AbortSignal } = {}) {}

  /** The first `xelatex` in the given directories (searched in order) or on PATH. */
  static async locate(directories: string[] = [], environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
    const windows = process.platform === 'win32'
    const path = (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean)
    const conventional = windows ? [] : ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin']
    for (const directory of [...directories, ...path, ...conventional]) {
      for (const name of windows ? ['xelatex.exe'] : ['xelatex']) {
        const candidate = join(directory, name)
        try {
          await access(candidate, windows ? undefined : 1)
          return candidate
        } catch {
          // Keep looking.
        }
      }
    }
    return undefined
  }

  async compile(directory: string): Promise<{ status: number; output: string }> {
    const { signal } = this.options
    signal?.throwIfAborted()
    const binDirectory = dirname(this.executable)
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      // Paranoid file access: page markup comes from a model reading an untrusted scan.
      openin_any: 'p',
      openout_any: 'p',
      max_print_line: '10000',
      [pathKey]: [binDirectory, process.env[pathKey]].filter(Boolean).join(delimiter)
    }
    const outputPath = join(directory, 'console.log')
    const output = createWriteStream(outputPath)
    const child = spawn(this.executable, ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-file-line-error', 'main.tex'], {
      cwd: directory,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.pipe(output, { end: false })
    child.stderr.pipe(output, { end: false })
    let reason: 'timeout' | 'abort' | undefined
    const stop = (why: 'timeout' | 'abort'): void => {
      reason ??= why
      // XeLaTeX runs xdvipdfmx as a child; on Windows only a tree kill stops both.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      } else {
        child.kill()
      }
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 4_000).unref()
    }
    const timer = setTimeout(() => stop('timeout'), this.options.timeoutMs ?? 180_000)
    const abort = (): void => stop('abort')
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve(code ?? 1))
      })
      await new Promise<void>((resolve) => output.end(resolve))
      if (reason === 'abort') throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      if (reason === 'timeout') throw new LatexError('LaTeX compilation timed out; look for a runaway argument or unclosed group')
      return { status, output: await readFile(outputPath, 'utf8').catch(() => '') }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (!output.closed) output.destroy()
    }
  }
}

export const CompilePatterns = {
  pages: new Pattern(String.raw`Output written on .*?\((\d+) pages?`),
  total: new Pattern(String.raw`REBUILD-TOTAL=([\d.]+)pt`),
  textHeight: new Pattern(String.raw`REBUILD-TEXTHEIGHT=([\d.]+)pt`),
  overfull: new Pattern(String.raw`Overfull \\hbox \(([\d.]+)pt too wide\)`),
  overfullParagraph: new Pattern(String.raw`Overfull \\hbox \(([\d.]+)pt too wide\) in paragraph at lines (\d+)--(\d+)`),
  overfullDisplay: new Pattern(String.raw`Overfull \\hbox \(([\d.]+)pt too wide\) detected at line (\d+)`),
  alignmentEnd,
  bodyStart: new Pattern(String.raw`REBUILD-BODY-START=([\d.]+)pt`),
  bodyEnd: new Pattern(String.raw`REBUILD-BODY-END=([\d.]+)pt`),
  errorLine: new Pattern(String.raw`^(?:\./)?main\.tex:(\d+): (.*)$`, { multiline: true }),
  lostCharacter: new Pattern(String.raw`Missing character: There is no (.*?) in font`),
  paragraphEnd: new Pattern(String.raw`\s*(\\end\{[^}]*\}|\\par|\\vfill|\\par\\typeout\{REBUILD-BODY-END=[^}]*\}\\vfill)?\s*`),
  wrapBefore: new Pattern(
    String.raw`(\\par\}?|\\vfill|\\\]|\\end\{[^}]*\}|\\begin\{[^}]*\}(\{\d+\})?|`
      + String.raw`\\vspace\*?\{[^}]*\}|\\rebuildsize\{[\d.]+\})\s*$`
  ),
  wrapAfter: new Pattern(String.raw`\s*\{?\\(par|vfill|end\{|begin\{|vspace|noindent|rebuildfigure|rebuildsize)`),
  wrapInside: new Pattern(String.raw`\\begin\{|\\end\{|\\\[|\\\]|(?<!\\)%`),
  whitespaceRun: new Pattern(String.raw`\s+`)
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** `compile_tex`: write main.tex, run XeLaTeX and read the measurements it logs. */
export async function compileTeX(directory: string, tex: string, compiler: TeXCompiling): Promise<CompileResult> {
  await mkdir(directory, { recursive: true })
  const pdf = join(directory, 'main.pdf')
  await atomicWriteFile(join(directory, 'main.tex'), tex)
  await rm(pdf, { force: true })
  const { status, output } = await compiler.compile(directory)
  const log = await readFile(join(directory, 'main.log')).then((data) => data.toString('utf8'), () => output)
  if (status !== 0 || !(await exists(pdf))) throw new LatexError(latexErrorMessage(log, tex))
  const number = (pattern: Pattern): number | undefined => {
    const match = pattern.search(log)
    return match ? parseDouble(match.at(1)) : undefined
  }
  const pageCount = (() => {
    const match = CompilePatterns.pages.search(log)
    return (match ? parseInt10(match.at(1)) : undefined) ?? 1
  })()
  const textHeight = number(CompilePatterns.textHeight) ?? 1
  const total = number(CompilePatterns.total) ?? 0
  const result: CompileResult = {
    pdf,
    pages: pageCount,
    naturalHeight: (pageCount - 1) * textHeight + total,
    textHeight,
    overfull: CompilePatterns.overfull.findAll(log).flatMap((value) => {
      const parsed = parseDouble(value)
      return parsed === undefined ? [] : [parsed]
    }),
    paragraphs: [],
    displays: [],
    scale: 1,
    paragraphSizes: new ParagraphSizes(),
    longLines: [],
    bodyHeight: 0,
    bodyStart: 0,
    spaceScale: 1
  }
  for (const groups of CompilePatterns.overfullParagraph.findAllGroups(log)) {
    const width = parseDouble(groups[0])
    const first = parseInt10(groups[1])
    const last = parseInt10(groups[2])
    if (width === undefined || first === undefined || last === undefined) continue
    const existing = result.paragraphs.find((entry) => entry.range.first === first && entry.range.last === last)
    if (existing) existing.overflow = Math.max(existing.overflow, width)
    else result.paragraphs.push({ range: { first, last }, overflow: Math.max(0, width) })
  }
  const rows = tex.split('\n')
  // TeX reports a display wider than its column at the line where the display ends.
  for (const groups of CompilePatterns.overfullDisplay.findAllGroups(log)) {
    const width = parseDouble(groups[0])
    const last = parseInt10(groups[1])
    if (width === undefined || last === undefined) continue
    const ending = last - 1 >= 0 && last - 1 < rows.length ? CompilePatterns.alignmentEnd.search(rows[last - 1]) : undefined
    const opening = ending ? `\\begin{${ending.at(1)}}` : '\\['
    let first: number | undefined
    for (let row = Math.min(last, rows.length); row >= 1; row -= 1) {
      if (rows[row - 1].includes(opening)) {
        first = row
        break
      }
    }
    if (first === undefined || !(last - 1 >= 0 && last - 1 < rows.length) || !(ending || rows[last - 1].includes('\\]'))) continue
    const existing = result.displays.find((entry) => entry.range.first === first && entry.range.last === last)
    if (existing) existing.overflow = Math.max(existing.overflow, width)
    else result.displays.push({ range: { first, last }, overflow: width })
  }
  const start = number(CompilePatterns.bodyStart)
  const end = number(CompilePatterns.bodyEnd)
  if (start !== undefined && end !== undefined) result.bodyHeight = Math.max(0, end - start)
  result.bodyStart = start ?? 0
  return result
}

/** `_latex_error`: the message sent back to the model when XeLaTeX fails. */
export function latexErrorMessage(log: string, tex: string): string {
  const lost = CompilePatterns.lostCharacter.search(log)
  if (lost) {
    return `the character ${lost.at(1)} cannot be typeset in text; write it in math mode with a `
      + 'LaTeX command (for example $\\subseteq$) or with a text escape'
  }
  const match = CompilePatterns.errorLine.search(log)
  if (!match) {
    const tail = PythonText.splitLines(log).filter((line) => line.startsWith('!'))
    return `LaTeX error: ${tail[0] ?? PythonText.suffix(log, 600)}`
  }
  const number = parseInt10(match.at(1)) ?? 0
  const lines = tex.split('\n')
  const offending = number > 0 && number <= lines.length ? PythonText.strip(lines[number - 1]) : ''
  return `LaTeX error '${PythonText.strip(match.at(2))}' near the source line: ${PythonText.prefix(offending, 300)}`
}

export interface TypesetOptions {
  directory: string
  markup: PageMarkup
  layout: PageLayout
  figures: PlacedFigures
  lineMode: LineMode
  compiler: TeXCompiling
  typography?: TranslationTypography
}

/**
 * `typeset_page`: compile one page so that every printed line and the whole page fit.
 *
 * First each overfull paragraph is set a step smaller (it was printed in smaller type,
 * such as an abstract or references); then the whole page shrinks uniformly until it
 * fits on one page. A displayed formula wider than its column is scaled down the same
 * way. Lines that would need more than 25% reduction are reported instead: they almost
 * always join several printed lines. Figures keep their printed size: the text area
 * reaches over every figure. The scan fitted its vertical gaps, so on a page set taller
 * than printed they narrow, by half and then completely, before the type shrinks.
 */
export async function typesetPage(options: TypesetOptions): Promise<CompileResult> {
  const { directory, markup, figures, lineMode, compiler, typography } = options
  const layout = coverFigures(options.layout, figures)
  let scale = 1
  const sizes = new ParagraphSizes()
  const displays = new ParagraphSizes()
  let space = 1
  const spaced = (markup.body + markup.footer).includes('\\vspace')
  for (let round = 0; round < 18; round += 1) {
    const tex = buildTeX({ markup, layout, figures, lineMode, scale, paragraphSizes: sizes, displayScales: displays, typography, spaceScale: space })
    const result = await compileTeX(directory, tex, compiler)
    if (lineMode === 'keep'
      && (shrinkParagraphs(result, tex, sizes, layout.textWidth)
        || shrinkReflowBlocks(result, tex, sizes, layout, true)
        || unifySizes(sizes))) continue
    if (lineMode === 'reflow' && shrinkReflowBlocks(result, tex, sizes, layout)) continue
    if (shrinkDisplays(result, displays, layout.textWidth)) continue
    if (result.pages <= 1) {
      result.scale = scale
      result.paragraphSizes = sizes
      result.layout = layout
      result.spaceScale = space
      // Report what the model wrote, without the scaling added around displays.
      const rows = buildTeX({ markup, layout, figures, lineMode, scale, paragraphSizes: sizes, typography }).split('\n')
      result.longLines = [...result.paragraphs, ...result.displays]
        .filter((entry) => entry.overflow > layout.textWidth * 0.04)
        .map((entry) => {
          const last = trimParagraph(rows, entry.range.first, entry.range.last)
          return plainRows(slice(rows, listingStart(rows, entry.range.first) - 1, last))
        })
      return result
    }
    if (spaced && space > 0) {
      space -= 0.5
      continue
    }
    // A block that cannot break, such as side-by-side blocks or a large figure, moves whole
    // to the next page and leaves the first one part empty: measure on a page tall enough.
    const tall = { ...layout, pageHeight: layout.pageHeight + 3 * layout.textHeight, textHeight: 4 * layout.textHeight }
    const natural = (await compileTeX(directory, buildTeX({
      markup, layout: tall, figures, lineMode, scale, paragraphSizes: sizes, displayScales: displays, typography, spaceScale: space
    }), compiler)).naturalHeight
    const overflow = Math.max(1.01, natural / result.textHeight)
    scale *= Math.max(0.85, Math.min(0.985, (0.99 / overflow) ** (lineMode === 'keep' ? 1 : 0.5)))
    if (scale < 0.7) break
  }
  throw new LatexError(
    'the page still overflows after shrinking the type to 70%; lines may be '
      + 'duplicated, or vertical space or figure boxes may be too large'
  )
}

/**
 * `_cover_figures`: extend the text area over each figure, so that it fits at its printed size.
 *
 * A page that is mostly drawing has little text to measure its text area from.
 */
export function coverFigures(layout: PageLayout, figures: PlacedFigures): PageLayout {
  const placed = figures.map((figure) => figure.placement).filter((placement) => placement.height > 0)
  if (!placed.length) return layout
  const top = Math.min(layout.top, ...placed.map((placement) => placement.top))
  const bottom = Math.max(layout.top + layout.textHeight, ...placed.map((placement) => placement.top + placement.height))
  return { ...layout, top, textHeight: bottom - top }
}

/** `_shrink_reflow_blocks`: reflow cannot wrap literal code or some formulas; fit those blocks to their column. */
export function shrinkReflowBlocks(result: CompileResult, tex: string, sizes: ParagraphSizes, layout: PageLayout, listingsOnly = false): boolean {
  const rows = tex.split('\n')
  const found = rows.findIndex((row) => row.startsWith('\\begin{document}'))
  const start = found >= 0 ? found : 0
  const contexts = lineContexts(rows.slice(start))
  let changed = false
  for (const { range, overflow } of result.paragraphs) {
    let first = range.first
    let last = range.last
    if (!(first - 1 >= 0 && first - 1 < rows.length)) continue
    let wrappable: boolean
    let listing: boolean
    if (PythonText.lstrip(rows[first - 1]).startsWith('\\end{verbatim}')) {
      first = listingStart(rows, first)
      wrappable = first < last
      listing = wrappable
    } else if (listingsOnly) {
      continue
    } else {
      last = trimParagraph(rows, first, last)
      wrappable = isWrappable(rows, first, last)
      listing = false
    }
    if (!wrappable) continue
    const frames = contexts[Math.max(0, first - 1 - start)].frames
    const width = frameWidth(frames, layout.textWidth, layout.columnGap, layout.size, 1)
    const key = { first, last }
    const current = sizes.get(key) ?? 1
    // Typewriter code from a proportionally set listing can need 40% less; anything
    // wider is reported. Other blocks needing more than 25% join several printed lines.
    const floor = listing ? 0.6 : 0.75
    let target = Math.floor(current * width / (width + overflow) * 40) / 40
    if (listing) target = Math.max(floor, target)
    if (floor <= target && target < current) {
      sizes.set(key, target)
      changed = true
    }
  }
  return changed
}

/** `_listing_start`: TeX reports a literal listing at its closing delimiter; return the opening line. */
export function listingStart(rows: readonly string[], first: number): number {
  if (!(first - 1 >= 0 && first - 1 < rows.length) || !PythonText.lstrip(rows[first - 1]).startsWith('\\end{verbatim}')) return first
  for (let row = first - 1; row > 0; row -= 1) if (rows[row - 1].includes('\\begin{verbatim}')) return row
  return first
}

/** `_shrink_displays`: scale each overwide displayed formula toward its column, by at most 25%. */
export function shrinkDisplays(result: CompileResult, scales: ParagraphSizes, width: number): boolean {
  let changed = false
  for (const { range, overflow } of result.displays) {
    const current = scales.get(range) ?? 1
    // The page's text width stands in for the unknown column width, so a display in a
    // narrow column shrinks over several rounds.
    const target = Math.max(0.75, Math.floor(current * width / (width + overflow) * 40) / 40)
    if (overflow >= width * 0.012 && target < current) {
      scales.set(range, target)
      changed = true
    }
  }
  return changed
}

/** `_shrink_paragraphs`: set each overfull printed paragraph one quantized step smaller. */
export function shrinkParagraphs(result: CompileResult, tex: string, sizes: ParagraphSizes, width: number): boolean {
  const rows = tex.split('\n')
  let changed = false
  for (const { range, overflow } of result.paragraphs) {
    const last = trimParagraph(rows, range.first, range.last)
    if (overflow < width * 0.012 || !isWrappable(rows, range.first, last)) continue
    const key = { first: range.first, last }
    const current = sizes.get(key) ?? 1
    // Quantized steps keep similar paragraphs (all references, say) at one size.
    const target = Math.floor(current * width / (width + overflow) * 40) / 40
    if (target >= 0.75 && target < current) {
      sizes.set(key, target)
      changed = true
    }
  }
  return changed
}

/** `_unify_sizes`: give the reduced paragraphs of a page one size when they differ by at most a few steps. */
export function unifySizes(sizes: ParagraphSizes): boolean {
  // Only clearly reduced paragraphs are small print; a title that needed a few percent keeps its size.
  const small = sizes.entries.filter((entry) => entry.factor <= 0.9).map((entry) => ({ range: entry.range, factor: entry.factor }))
  if (!small.length) return false
  const floor = Math.min(...small.map((entry) => entry.factor))
  let changed = false
  for (const { range, factor } of small) {
    const unified = factor - floor <= 0.1 + 1e-9 ? floor : factor
    if (sizes.get(range) !== unified) changed = true
    sizes.set(range, unified)
  }
  return changed
}

/** `_trim`: TeX counts the line that ends a paragraph (blank, \end{...}, the body's end marker) as part of it; drop it. */
export function trimParagraph(rows: readonly string[], first: number, last: number): number {
  let end = last
  while (end > first && end - 1 >= 0 && end - 1 < rows.length && CompilePatterns.paragraphEnd.fullMatch(rows[end - 1]) !== undefined) end -= 1
  return end
}

/** `_wrappable`: can lines first...last be wrapped in a size group without splitting a structure? */
export function isWrappable(rows: readonly string[], first: number, last: number): boolean {
  if (!(first > 1 && first <= last && last < rows.length)) return false
  const before = rows[first - 2]
  const after = rows[last]
  const inside = rows.slice(first - 1, last).join('\n')
  return (!PythonText.strip(before) || CompilePatterns.wrapBefore.contains(before))
    && (!PythonText.strip(after) || CompilePatterns.wrapAfter.match(after) !== undefined)
    && !CompilePatterns.wrapInside.contains(inside)
}

/** `_plain_rows`: a readable excerpt of the rows of an overfull paragraph. */
export function plainRows(rows: readonly string[]): string {
  const text = untagDisplays(rows.join(' ')).replaceAll('\\linebreak\\relax', ' / ').replaceAll('~', ' ')
  return PythonText.prefix(PythonText.strip(CompilePatterns.whitespaceRun.sub(text, ' ')), 240)
}

/** `rows[from:to]` with Python's forgiving bounds. */
export function slice(rows: readonly string[], start: number, end: number): string[] {
  const lower = Math.max(0, Math.min(start, rows.length))
  const upper = Math.max(lower, Math.min(end, rows.length))
  return rows.slice(lower, upper)
}
