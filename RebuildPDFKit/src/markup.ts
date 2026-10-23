import { MarkupError } from './errors'
import { Pattern, PythonNumber, PythonText, doubleDescription, parseDouble } from './pattern'

/** A figure box in whole-page coordinates from 0 to 1000, origin top-left. */
export interface FigureBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function figureBox(x0: number, y0: number, x1: number, y1: number): FigureBox {
  return { x0, y0, x1, y1 }
}

function boxValues(box: FigureBox): number[] {
  return [box.x0, box.y0, box.x1, box.y1]
}

function sameBox(a: FigureBox | undefined, b: FigureBox | undefined): boolean {
  return Boolean(a && b) && a!.x0 === b!.x0 && a!.y0 === b!.y0 && a!.x1 === b!.x1 && a!.y1 === b!.y1
}

/** Figure boxes keyed by their call name (f1, f2, ...), in markup order. */
export class FigureBoxes {
  entries: Array<{ key: string; box: FigureBox }> = []

  get isEmpty(): boolean { return this.entries.length === 0 }
  get count(): number { return this.entries.length }
  get keys(): string[] { return this.entries.map((entry) => entry.key) }

  get(key: string): FigureBox | undefined {
    return this.entries.find((entry) => entry.key === key)?.box
  }

  set(key: string, box: FigureBox | undefined): void {
    const index = this.entries.findIndex((entry) => entry.key === key)
    if (index >= 0) {
      if (box) this.entries[index] = { key, box }
      else this.entries.splice(index, 1)
    } else if (box) {
      this.entries.push({ key, box })
    }
  }

  clone(): FigureBoxes {
    const copy = new FigureBoxes()
    copy.entries = this.entries.map((entry) => ({ key: entry.key, box: { ...entry.box } }))
    return copy
  }

  /** Dictionary equality: the same boxes under the same names, in any order. */
  equals(other: FigureBoxes): boolean {
    return this.count === other.count && this.entries.every((entry) => sameBox(other.get(entry.key), entry.box))
  }
}

/** One page as constrained LaTeX, in the `<page>` format the prompts describe. */
export class PageMarkup {
  static readonly fonts = ['serif', 'sans', 'typewriter']

  body: string
  header: string
  footer: string
  font: string
  columns: number
  figures: FigureBoxes
  notes: string[]

  constructor(options: { body: string; header?: string; footer?: string; font?: string; columns?: number; figures?: FigureBoxes; notes?: string[] }) {
    this.body = options.body
    this.header = options.header ?? ''
    this.footer = options.footer ?? ''
    this.font = options.font ?? 'serif'
    this.columns = options.columns ?? 1
    this.figures = options.figures ?? new FigureBoxes()
    this.notes = options.notes ?? []
  }

  clone(): PageMarkup {
    return new PageMarkup({
      body: this.body, header: this.header, footer: this.footer, font: this.font, columns: this.columns,
      figures: this.figures.clone(), notes: [...this.notes]
    })
  }

  equals(other: PageMarkup): boolean {
    return this.body === other.body && this.header === other.header && this.footer === other.footer
      && this.font === other.font && this.columns === other.columns && this.figures.equals(other.figures)
      && this.notes.length === other.notes.length && this.notes.every((note, index) => note === other.notes[index])
  }

  serialize(): string {
    const figureLines = this.figures.entries
      .map((entry) => `${entry.key}: ${boxValues(entry.box).map(PythonNumber.general).join(' ')}`)
      .join('\n')
    return `<page font="${this.font}" columns="${this.columns}">\n`
      + `<header>${this.header}</header>\n<body>\n${this.body}\n</body>\n`
      + `<footer>\n${this.footer}\n</footer>\n<figures>\n${figureLines}\n</figures>\n`
      + `<notes>\n${this.notes.join('\n')}\n</notes>\n</page>\n`
  }

  /** `parse_markup`: read and check a `<page>` reply. */
  static parse(text: string): PageMarkup {
    if (!PythonText.strip(text)) throw new MarkupError('empty reply; return the complete <page> markup')
    const match = MarkupPatterns.page.search(text)
    if (!match) throw new MarkupError('the reply has no complete <page> ... </page> element')
    const attributes = new Map<string, string>()
    for (const pair of MarkupPatterns.attribute.findAllGroups(match.at(1))) attributes.set(pair[0], pair[1])
    const sections = new Map<string, string>()
    for (const pair of MarkupPatterns.section.findAllGroups(match.at(2))) {
      const name = pair[0]
      if (sections.has(name)) throw new MarkupError(`<${name}> occurs twice`)
      const lines = pair[1].replaceAll('\r\n', '\n').split('\n').map(PythonText.rstrip)
      sections.set(name, PythonText.strip(lines.join('\n'), '\n'))
    }
    const body = sections.get('body')
    if (body === undefined) throw new MarkupError('<body> is missing')
    const figures = new FigureBoxes()
    for (const line of PythonText.splitLines(sections.get('figures') ?? '')) {
      if (!PythonText.strip(line)) continue
      const item = MarkupPatterns.figureLine.fullMatch(line)
      if (!item) {
        throw new MarkupError(`figure line ${PythonText.repr(PythonText.strip(line))} must look like 'f1: x0 y0 x1 y1'`)
      }
      const coordinates = [2, 3, 4, 5].map((index) => {
        const value = parseDouble(item.at(index))
        if (value === undefined) {
          throw new MarkupError(`figure ${item.at(1)} has an invalid coordinate ${PythonText.repr(item.at(index))}`)
        }
        return value
      })
      const box = figureBox(coordinates[0], coordinates[1], coordinates[2], coordinates[3])
      if (!(box.x0 >= 0 && box.x0 < box.x1 && box.x1 <= 1000 && box.y0 >= 0 && box.y0 < box.y1 && box.y1 <= 1000)) {
        const shown = `(${coordinates.map(doubleDescription).join(', ')})`
        throw new MarkupError(`figure ${item.at(1)} box ${shown} must satisfy 0 <= x0 < x1 <= 1000 and 0 <= y0 < y1 <= 1000`)
      }
      figures.set(item.at(1), box)
    }
    const font = PythonText.strip(attributes.get('font') ?? 'serif').toLowerCase()
    const columns = PythonText.strip(attributes.get('columns') ?? '1')
    const markup = new PageMarkup({
      body,
      header: PythonText.strip((sections.get('header') ?? '').split('\n').join(' ')),
      footer: sections.get('footer') ?? '',
      font: PageMarkup.fonts.includes(font) ? font : 'serif',
      columns: columns === '2' || columns === '3' ? Number(columns) : 1,
      figures,
      notes: PythonText.splitLines(sections.get('notes') ?? '').map((note) => PythonText.strip(note)).filter(Boolean)
    })
    markup.validate()
    return markup
  }

  /** `validate_markup`: reject unsafe or malformed LaTeX and drop figure boxes that are never placed. */
  validate(): void {
    this.header = tagNumbers(literalPercents(this.header))
    this.body = tagNumbers(literalPercents(this.body))
    this.footer = tagNumbers(literalPercents(this.footer))
    const source = [this.header, this.body, this.footer].join('\n')
    if (!PythonText.strip(this.body) && this.figures.isEmpty) throw new MarkupError('<body> is empty')
    const scanned = MarkupPatterns.verbatim.sub(source, '')
    if (scanned.includes('^^')) {
      throw new MarkupError("'^^' character codes are not allowed; write the symbol with a LaTeX command")
    }
    if (scanned.includes('$$')) throw new MarkupError('use \\[ ... \\] for displayed math, not $$')
    const forbidden = MarkupPatterns.forbidden.search(scanned)
    if (forbidden) throw new MarkupError(`\\${forbidden.at(1)} is not allowed in page markup`)
    // Each open environment with the number of \nextside it still expects.
    const stack: Array<{ name: string; separators: number }> = []
    for (const token of MarkupPatterns.structureToken.matches(scanned)) {
      const kind = token.group(1)
      if (kind === undefined) {
        if (stack.at(-1)?.name !== 'sidebyside') {
          throw new MarkupError('\\nextside may only separate the blocks of a sidebyside, outside any other environment')
        }
        stack[stack.length - 1].separators -= 1
        if (stack[stack.length - 1].separators < 0) throw new MarkupError('a sidebyside has more \\nextside than block widths')
        continue
      }
      const name = token.at(2)
      if (!allowedEnvironments.has(name)) throw new MarkupError(`environment {${name}} is not allowed`)
      if (kind === 'begin') {
        if (name === 'multicols' && !['2', '3'].includes(PythonText.strip(token.group(3) ?? ''))) {
          throw new MarkupError('multicols takes 2 or 3 columns, as in \\begin{multicols}{2}')
        }
        if (name === 'sidebyside' && stack.length) throw new MarkupError('sidebyside may not be nested inside another environment')
        stack.push({ name, separators: name === 'sidebyside' ? sideFractions(token.group(3)).length - 1 : 0 })
        continue
      }
      const open = stack.at(-1)
      if (!open || open.name !== name) throw new MarkupError(`\\end{${name}} does not match an open environment`)
      stack.pop()
      if (open.separators !== 0) throw new MarkupError('each block of a sidebyside except the last must end with \\nextside')
    }
    const open = stack.at(-1)
    if (open) throw new MarkupError(`environment {${open.name}} is not closed`)
    let depth = 0
    for (const character of MarkupPatterns.escape.sub(scanned, '')) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
      if (depth < 0) throw new MarkupError("unbalanced braces: a '}' has no matching '{'")
    }
    if (depth !== 0) throw new MarkupError("unbalanced braces: a '{' is not closed")
    // Read escapes left to right: in \\[2pt] (a line break with extra space) "[" is not math.
    const escapes = MarkupPatterns.escape.findAll(scanned)
    if (escapes.filter((escape) => escape === '\\[').length !== escapes.filter((escape) => escape === '\\]').length) {
      throw new MarkupError('unbalanced \\[ ... \\] display math')
    }
    const placed = MarkupPatterns.figureCall.findAll(source)
    const keys = new Set(this.figures.keys)
    const missing = [...new Set(placed)].filter((key) => !keys.has(key)).sort()[0]
    if (missing !== undefined) throw new MarkupError(`\\rebuildfigure{${missing}} has no box in <figures>`)
    if (placed.length !== new Set(placed).size) throw new MarkupError('each figure may be placed only once')
    for (const unused of this.figures.keys.filter((key) => !placed.includes(key))) this.figures.set(unused, undefined)
  }
}

const verbatimSource = String.raw`\\begin\{verbatim\}.*?\\end\{verbatim\}`

export const MarkupPatterns = {
  page: new Pattern(String.raw`<page\b([^>]*)>(.*?)</page>`, { dotAll: true }),
  attribute: new Pattern(String.raw`(\w+)\s*=\s*"([^"]*)"`),
  section: new Pattern(String.raw`<(header|body|footer|figures|notes)>(.*?)</\1>`, { dotAll: true }),
  figureLine: new Pattern(String.raw`\s*(f\d+)\s*[:=]?\s*\[?\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*\]?\s*`),
  verbatimSource,
  verbatim: new Pattern(verbatimSource, { dotAll: true }),
  percentScan: new Pattern(verbatimSource + String.raw`|\\verb\*?([^\sA-Za-z*])[^\n]*?\1|\\.|%`, { dotAll: true }),
  commentStart: new Pattern(String.raw`(?:^|\\[A-Za-z]+\*?)[ \t]*$`),
  commentBrace: new Pattern(String.raw`(?<!\\)[{}][ \t]*$`),
  figureCall: new Pattern(String.raw`\\rebuildfigure\{(f\d+)\}`),
  environment: new Pattern(String.raw`\\(begin|end)\{([^}]*)\}`),
  /** Environment boundaries with an argument such as {2} or {0.45,0.55}, and block separators. */
  structureToken: new Pattern(String.raw`\\(begin|end)\{([^}]*)\}(?:\{([^{}]*)\})?|\\nextside(?![A-Za-z])`),
  /** A line break (\\, also \\[2pt]) is read first, so its "[" never opens a display. */
  displayScan: new Pattern(verbatimSource + String.raw`|\\\\|\\\[|\\\]`, { dotAll: true }),
  rowSeparator: new Pattern(String.raw`(\\\\(?:\[[^\]]*\])?)`),
  rowEnd: new Pattern(String.raw`\s*\\end\{(?:aligned|gathered|alignedat)\}\s*$`),
  /** A printed equation number set off from its formula by explicit space: "\qquad (9)". */
  numberEnd: (() => {
    const spacing = String.raw`(?:\s|~|\\[,;:!]|\\q?quad(?![A-Za-z])|\\hfill(?![A-Za-z])|\\hspace\*?\{[^{}]*\})`
    const label = String.raw`(\((?:(?:\d+|[IVX]+)(?:[.\-]\d+)*[a-z]?'?|\*{1,3})\))`
    return new Pattern(
      spacing + String.raw`*(?:\\q?quad(?![A-Za-z])|\\hfill(?![A-Za-z])|\\hspace\*?\{[^{}]*\})` + spacing
        + String.raw`*(?:\\(?:text|textrm|mathrm)\{\s*` + label + String.raw`\s*\}|` + label + String.raw`)\s*$`
    )
  })(),
  escape: new Pattern(String.raw`\\.`, { dotAll: false }),
  forbidden: new Pattern(
    String.raw`\\(input|include|includeonly|includegraphics|openin|openout|read|readline|write|immediate|`
      + String.raw`catcode|uccode|lccode|mathcode|def|edef|gdef|xdef|let|futurelet|newcommand|renewcommand|`
      + String.raw`providecommand|DeclareRobustCommand|newenvironment|renewenvironment|usepackage|RequirePackage|`
      + String.raw`documentclass|special|directlua|latelua|csname|endcsname|expandafter|makeatletter|`
      + String.raw`scantokens|everypar|everymath|everydisplay|output|afterassignment|jobname|`
      + String.raw`verbatiminput|lstinputlisting|section|subsection|subsubsection|paragraph|chapter|`
      + String.raw`footnote|item|maketitle|newpage|clearpage|pagebreak)(?![A-Za-z@])`
  )
}

const allowedEnvironments = new Set([
  'center', 'flushleft', 'flushright', 'quote', 'quotation', 'indentblock', 'multicols',
  'verbatim', 'tabular', 'array', 'aligned', 'alignedat', 'gathered', 'split', 'cases',
  'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix',
  'align*', 'gather*', 'equation*', 'multline*', 'sidebyside'
])

/**
 * `_literal_percents`: page markup has no comments, so a bare % is printed unless it is
 * plainly a TeX comment (at a line start, after a control word, or ending a line after a
 * brace). Such a comment is removed, a comment-only line with its line break.
 */
export function literalPercents(text: string): string {
  let output = ''
  let position = 0
  for (let match = MarkupPatterns.percentScan.search(text, position); match; match = MarkupPatterns.percentScan.search(text, position)) {
    output += text.slice(position, match.start)
    position = match.end
    if (match.text !== '%') {
      output += match.text
      continue
    }
    const previousBreak = match.start > 0 ? text.lastIndexOf('\n', match.start - 1) : -1
    const lineStart = previousBreak + 1
    const before = text.slice(lineStart, match.start)
    const nextBreak = text.indexOf('\n', match.start)
    const end = nextBreak < 0 ? text.length : nextBreak
    const rest = text.slice(match.end, end)
    if (!(MarkupPatterns.commentStart.contains(before) || (MarkupPatterns.commentBrace.contains(before) && !PythonText.strip(rest)))) {
      output += String.raw`\%`
      continue
    }
    while (output.endsWith(' ') || output.endsWith('\t')) output = output.slice(0, -1)
    position = Math.min(text.length, end + (PythonText.strip(before) ? 0 : 1))
  }
  return output + text.slice(position)
}

/**
 * `_tag_numbers`: write a printed equation number set after explicit space as \tag*{...}.
 *
 * Older transcriptions put "(9)" after \qquad, which centres it with the formula
 * instead of setting it at the right margin.
 */
export function tagNumbers(source: string): string {
  let text = source
  for (const span of displaySpans(text).reverse()) {
    const content = text.slice(span.start + 2, span.end - 2)
    if (content.includes('\\tag')) continue
    const rows = MarkupPatterns.rowSeparator.split(content)
    for (let index = 0; index < rows.length; index += 2) {
      let row = rows[index]
      let tail = ''
      const closing = MarkupPatterns.rowEnd.search(row)
      if (closing) {
        tail = row.slice(closing.start)
        row = row.slice(0, closing.start)
      }
      const number = MarkupPatterns.numberEnd.search(row)
      if (number) rows[index] = `${row.slice(0, number.start)} \\tag*{${number.group(1) ?? number.at(2)}}${tail}`
    }
    text = text.slice(0, span.start + 2) + rows.join('') + text.slice(span.end - 2)
  }
  return text
}

/** `_side_fractions`: the block widths of a sidebyside, as fractions of the text width. */
export function sideFractions(argument: string | undefined): number[] {
  const fractions = (argument ?? '').split(',').map((value) => parseDouble(PythonText.strip(value)))
  if (fractions.length < 2 || fractions.length > 4 || !fractions.every((value) => value !== undefined && value > 0 && value <= 1)) {
    throw new MarkupError('sidebyside takes the printed width of each block as a fraction of the text width, '
      + 'as in \\begin{sidebyside}{0.45,0.55}')
  }
  return fractions as number[]
}

/** `_display_spans`: UTF-16 offsets of each \[ ... \] display, including its delimiters, outside verbatim. */
export function displaySpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let start: number | undefined
  for (const match of MarkupPatterns.displayScan.matches(text)) {
    if (match.text === '\\[' && start === undefined) start = match.start
    else if (match.text === '\\]' && start !== undefined) {
      spans.push({ start, end: match.end })
      start = undefined
    }
  }
  return spans
}

/** `strip_fences`: drop a Markdown code fence around a reply. */
export function stripFences(text: string): string {
  return fencePattern.sub(PythonText.strip(text), '')
}

const fencePattern = new Pattern('^```[a-zA-Z]*\\n|\\n```\\s*$')
