import { closingBrace } from './braces'
import { MarkupPatterns } from './markup'
import { Pattern, PythonNumber, PythonText, parseDouble } from './pattern'

/** How printed line ends become LaTeX: `keep` locks every printed line, `reflow` lets TeX break paragraphs. */
export type LineMode = 'keep' | 'reflow'

/**
 * An environment around a line: its name, its argument such as {2} or {0.45,0.55}, and in a
 * sidebyside the number of \nextside passed, which is the block the line is in.
 */
export interface LineFrame {
  name: string
  argument?: string
  block: number
}

export function sameFrames(a: readonly LineFrame[], b: readonly LineFrame[]): boolean {
  return a.length === b.length && a.every((frame, index) => frame.name === b[index].name
    && frame.argument === b[index].argument && frame.block === b[index].block)
}

export interface LineContext {
  breakable: boolean
  environment: string
  frames: LineFrame[]
}

export const LineRules = {
  textEnvironments: new Set(['multicols', 'rebuildflow', 'quote', 'quotation', 'indentblock', 'sidebyside']),
  lineEnvironments: new Set(['center', 'flushleft', 'flushright']),

  blockLine: new Pattern(
    String.raw`\s*(\\\[|\\begin\{|\\end\{|\\columnbreak|\\nextside|\\rebuildfigure|\\vspace|\\noindent|\\par\b|`
      + String.raw`\\medskip|\\bigskip|\\smallskip|\\rule)`
  ),
  /** The environment structure of a line; a line break (\\, also \\[2pt]) never opens a display. */
  contextToken: new Pattern(
    String.raw`\\\\|\\begin\{([^}]*)\}(?:\{([^{}]*)\})?|\\end\{([^}]*)\}|(\\\[)|(\\\])|(\\nextside)(?![A-Za-z])`
  ),
  endsBreak: new Pattern(String.raw`(\\\\|\\linebreak|\\newline|\\par|(?<!\\)%|\\\]|\\end\{[^}]*\})\s*$`),
  /** Lines that only add vertical material; the text line before them ends its paragraph. */
  spaceOnly: new Pattern(
    String.raw`(\s|\\vspace\*?\{[^{}]*\}|\\(?:medskip|bigskip|smallskip|par)\b|\\rebuildfigure\{[^{}]*\})+`
  ),
  newBlock: new Pattern(String.raw`\s*\\(noindent|vspace|medskip|bigskip|smallskip|rebuildfigure|par\b)`),
  lowerCaseStart: new Pattern(String.raw`\s*[a-z]`),
  ruleLine: new Pattern(String.raw`\s*(?:\\noindent\b\s*)?(\\rule\{[^{}]*\}\{[^{}]*\})\s*`),
  // Han, kana, CJK and full-width punctuation: TeX must not see a space between two of them.
  cjkEnd: new Pattern(String.raw`[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯][{}\s]*$`),
  cjkStart: new Pattern(String.raw`(?:\s|[{}]|\\[A-Za-z]+\*?)*[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]`),
  /** Group braces and font switches on their own line do not print a text line. */
  styleOnly: new Pattern(
    String.raw`\s*(?:[{}]|\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|`
      + String.raw`rmfamily|sffamily|ttfamily|bfseries|mdseries|itshape|slshape|upshape|scshape)\b\s*)+\s*`
  ),

  structuralLine: new Pattern(String.raw`\\begin\{|\\end\{|\\\[|\\\]|\\nextside(?![A-Za-z])`),
  lonelyFigure: new Pattern(String.raw`\s*\\rebuildfigure\{f\d+\}\s*`),
  inlineMath: new Pattern(String.raw`(\$[^$]*\$)`),
  breakableSpace: new Pattern(String.raw`(\\[A-Za-z]+\*?)?((?<!\\) +)`),
  explicitSpace: new Pattern(String.raw`(?<!\\nobreak)(\\(?:quad|qquad|hfill|hspace\*?)(?![A-Za-z])|\\ )`),
  openingStructure: new Pattern(String.raw`\\begin\{|\\end\{|\\\[`),
  leadingNoindent: new Pattern(String.raw`^\s*\\noindent\b\s*`),
  mathSpan: new Pattern(String.raw`\$[^$]*\$`),
  equationNumber: new Pattern(String.raw`^\(\d+[a-z]?\)\s*`),
  typewriterOpening: new Pattern(String.raw`\\texttt\s*\{`),
  listingPunctuation: new Pattern(String.raw`[\s,.;:()]*`)
}

/** `_body_lines`: (line, enclosing environments, is the last line of its paragraph) for running text. */
export function bodyLines(text: string): Array<{ line: string; frames: LineFrame[]; last: boolean }> {
  const lines = text.split('\n')
  const contexts = lineContexts(lines)
  const output: Array<{ line: string; frames: LineFrame[]; last: boolean }> = []
  lines.forEach((line, index) => {
    if (!contexts[index].breakable) return
    const following = index + 1 < lines.length ? lines[index + 1] : ''
    const last = !PythonText.strip(following) || LineRules.blockLine.match(following) !== undefined
      || LineRules.styleOnly.fullMatch(following) !== undefined
    output.push({ line, frames: contexts[index].frames, last })
  })
  return output
}

/**
 * `_line_contexts`: for each line, is it running text that may end in a forced break, its innermost
 * environment, and its enclosing environments from the outside in.
 */
export function lineContexts(lines: readonly string[]): LineContext[] {
  const stack: LineFrame[] = []
  let display = false
  const contexts: LineContext[] = []
  for (const line of lines) {
    const texty = !display && stack.every((frame) => LineRules.textEnvironments.has(frame.name) || LineRules.lineEnvironments.has(frame.name))
    const environment = stack.at(-1)?.name ?? ''
    const frames = stack.map((frame) => ({ ...frame }))
    const structural = LineRules.structuralLine.contains(line) || LineRules.spaceOnly.fullMatch(line) !== undefined
      || LineRules.styleOnly.fullMatch(line) !== undefined
    for (const token of LineRules.contextToken.matches(line)) {
      const begin = token.group(1)
      if (begin !== undefined) stack.push({ name: begin, argument: token.group(2), block: 0 })
      else if (token.group(3) !== undefined) {
        if (stack.length) stack.pop()
      } else if (token.group(4) !== undefined) display = true
      else if (token.group(5) !== undefined) display = false
      else if (token.group(6) !== undefined && stack.length) stack[stack.length - 1].block += 1
    }
    contexts.push({
      breakable: texty && !structural && Boolean(PythonText.strip(line)) && !stack.some((frame) => frame.name === 'verbatim'),
      environment,
      frames
    })
  }
  return contexts
}

/**
 * `_side_widths`: the widths of the blocks of a sidebyside, in points.
 *
 * The printed fractions share the text width less the gaps between blocks. On a page set
 * in columns, blocks whose fractions are close to whole columns span exactly those columns,
 * so the blocks line up with the column grid. Widths already given in bp are kept.
 */
export function sideWidths(argument: string, width: number, gap: number, columns: number): number[] {
  const values = argument.split(',').map((value) => PythonText.strip(value))
  if (values.every((value) => value.endsWith('bp'))) return values.map((value) => parseDouble(value.slice(0, -2)) ?? 0)
  const fractions = values.map((value) => parseDouble(value) ?? 0)
  const total = fractions.reduce((sum, value) => sum + value, 0)
  const spans = fractions.map((value) => PythonNumber.round(value / total * columns))
  if (columns > 1 && Math.min(...spans) >= 1 && spans.reduce((sum, value) => sum + value, 0) === columns
    && fractions.every((value, index) => Math.abs(value / total * columns - spans[index]) < 0.25)) {
    const column = (width - (columns - 1) * gap) / columns
    return spans.map((span) => span * column + (span - 1) * gap)
  }
  const room = width - (fractions.length - 1) * gap
  return fractions.map((value) => room * value / total)
}

/** `_frame_width`: the measure of a line set inside these environments, in points. */
export function frameWidth(frames: readonly LineFrame[], width: number, gap: number, size: number, columns: number): number {
  let measure = width
  for (const frame of frames) {
    if (frame.name === 'multicols' || frame.name === 'rebuildflow') {
      const count = PythonText.strip(frame.argument ?? '') === '3' ? 3 : 2
      measure = (measure - (count - 1) * gap) / count
    } else if (frame.name === 'sidebyside') {
      measure = sideWidths(frame.argument ?? '', measure, gap, columns)[frame.block]
    } else if (['indentblock', 'quote', 'quotation'].includes(frame.name)) {
      measure -= 3 * size
    }
  }
  return measure
}

/** `_inline_figures`: a figure sharing its line with other material sits in that line, at its printed size. */
export function inlineFigures(text: string): string {
  return text.split('\n').map((line) => LineRules.lonelyFigure.fullMatch(line)
    ? line
    : MarkupPatterns.figureCall.sub(line, (match) => `\\rebuildinlinefigure{${match.at(1)}}`))
    .join('\n')
}

/** `_lock_spaces`: make interword spaces unbreakable so TeX cannot add breaks inside a printed line. */
export function lockSpaces(line: string): string {
  const parts = LineRules.inlineMath.split(PythonText.strip(line))
  for (let index = 0; index < parts.length; index += 2) {
    // A space after a control word is consumed by TeX, and "\ " is a control space:
    // turning either into ~ would add a space or form an accent.
    const part = LineRules.breakableSpace.sub(parts[index], (match) => match.group(1) !== undefined ? match.text : '~')
    // Explicit horizontal space is breakable glue as well.
    parts[index] = LineRules.explicitSpace.sub(part, (match) => `\\nobreak${match.at(1)}`)
  }
  return parts.join('')
}

/**
 * `_attach_column_breaks`: put a lone \columnbreak at the end of the left column's last printed line.
 *
 * After a forced line break, multicol would otherwise apply it one line too late.
 */
export function attachColumnBreaks(lines: readonly string[]): string[] {
  const output: string[] = []
  const contexts = lineContexts(lines)
  lines.forEach((line, index) => {
    const previous = output.at(-1) ?? ''
    if (PythonText.strip(line) === '\\columnbreak'
      && contexts[index].environment !== 'verbatim'
      && PythonText.strip(previous)
      && !LineRules.endsBreak.contains(previous)
      && LineRules.spaceOnly.fullMatch(previous) === undefined
      && LineRules.styleOnly.fullMatch(previous) === undefined
      && !LineRules.openingStructure.contains(previous)) {
      output[output.length - 1] = `${PythonText.rstrip(previous)}\\columnbreak`
    } else {
      output.push(line)
    }
  })
  return output
}

/** `_code_line`: a complete line of inline code is a listing row, even in reflow mode. */
export function isCodeLine(line: string): boolean {
  let text = PythonText.strip(LineRules.leadingNoindent.sub(line, ''))
  if (!text.includes('\\texttt')) return false
  // Listings may alternate typewriter identifiers and mathematical variables,
  // and may start with an equation number, e.g. (3a) \texttt{Append(}$x$,...).
  text = LineRules.mathSpan.sub(text, '')
  text = LineRules.equationNumber.sub(text, '')
  for (let match = LineRules.typewriterOpening.search(text); match; match = LineRules.typewriterOpening.search(text)) {
    const end = closingBrace(text, match.end)
    if (end === undefined) return false
    text = text.slice(0, match.start) + text.slice(Math.min(end, text.length))
  }
  return LineRules.listingPunctuation.fullMatch(text) !== undefined
}

/**
 * `apply_line_breaks`: turn one-printed-line-per-source-line markup into LaTeX line breaks.
 *
 * keep: every non-final line of a paragraph ends with \linebreak (justified), or with
 * \newline when it is clearly shorter than the measure; reflow: lines are joined and TeX
 * breaks paragraphs itself. Line-end hyphens follow the same choice.
 */
export function applyLineBreaks(text: string, mode: LineMode, ratio?: (line: string, frames: LineFrame[]) => number): string {
  const split = text.split('\n')
  const lines = mode === 'keep' ? attachColumnBreaks(split) : split
  const contexts = lineContexts(lines)
  const output: string[] = []
  let joinNext = false
  let unindentNext = false
  let afterBreak = false
  lines.forEach((original, index) => {
    let line = original
    if (['\\columnbreak', '\\nextside'].includes(PythonText.strip(line)) && contexts[index].environment !== 'verbatim') {
      // A standalone column break is structural, including after a caption or blank
      // line in keep mode. End the paragraph and never append a text-line break; the
      // next side-by-side block starts the same way.
      output.push('', line, '')
      joinNext = false
      afterBreak = true
      return
    }
    const { breakable, environment, frames } = contexts[index]
    const rule = breakable && !LineRules.lineEnvironments.has(environment) ? LineRules.ruleLine.fullMatch(line) : undefined
    if (rule) {
      // A full-width rule is a paragraph of its own: indented it overflows, and sharing
      // a paragraph with text it forces a justified, letter-spaced line before the next
      // rule. Text printed under it continues flush left.
      output.push('', `\\noindent${rule.at(1)}\\par`)
      joinNext = false
      unindentNext = true
      return
    }
    if (unindentNext && PythonText.strip(line) && LineRules.blockLine.match(line) === undefined) {
      line = `\\noindent ${PythonText.lstrip(line)}`
    } else if (afterBreak && breakable && LineRules.lowerCaseStart.match(line) !== undefined) {
      // A column opening in lower case continues the paragraph broken at the last foot.
      line = `\\noindent ${PythonText.lstrip(line)}`
    }
    unindentNext = false
    afterBreak = afterBreak && !PythonText.strip(line)
    const following = index + 1 < lines.length ? lines[index + 1] : ''
    const continues = breakable && Boolean(PythonText.strip(following))
      && LineRules.blockLine.match(following) === undefined && LineRules.styleOnly.fullMatch(following) === undefined
      && !LineRules.endsBreak.contains(line)
    const soft = line.endsWith('\\-')
    const hyphenated = soft || (line.endsWith('-') && !line.endsWith('--'))
    // Reflowed Chinese: a line end between two CJK characters, even across a style group
    // such as one \textit{...} per printed line, would print as a space.
    const cjk = continues && LineRules.cjkEnd.contains(line) && LineRules.cjkStart.match(following) !== undefined
    const joined = mode === 'reflow' && continues && !LineRules.lineEnvironments.has(environment) && (hyphenated || cjk)
    if (soft && !joined) line = `${line.slice(0, -2)}-` // a split word keeps its printed hyphen at a line end
    if (mode === 'keep' && breakable) line = lockSpaces(line)
    if (joinNext) line = output.pop()! + PythonText.lstrip(line)
    joinNext = joined
    if (!continues) {
      output.push(line)
      if (breakable && LineRules.newBlock.match(following) !== undefined) output.push('') // vertical space or a new unindented paragraph needs a \par
    } else if (LineRules.lineEnvironments.has(environment) || isCodeLine(line) || (mode === 'reflow' && isCodeLine(following))) {
      // \\ would end a paragraph inside center and add the paragraph gap between lines.
      output.push(`${line}\\newline\\relax`)
    } else if (mode === 'keep') {
      const fill = ratio ? ratio(line, frames) : 1
      const short = ratio !== undefined && (fill === 0 ? 1 : fill) < 0.82
      // \relax stops a following "[2, 8]" line from becoming an optional argument.
      output.push(line + (short ? '\\newline\\relax' : '\\linebreak\\relax'))
    } else {
      output.push(line)
    }
  })
  return output.join('\n')
}
