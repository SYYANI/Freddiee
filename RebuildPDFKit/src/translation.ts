import { closingBrace } from './braces'
import { LatexError, MarkupError, RebuildError } from './errors'
import type { PageMeasure } from './geometry'
import { LineRules, lineContexts } from './lineBreaks'
import { PageMarkup, stripFences } from './markup'
import { type CheckpointedModel, type RebuildMessage, type RebuildUsage, addUsage, emptyUsage, textMessage } from './model'
import { Pattern, PythonText } from './pattern'
import { RebuildPrompts } from './prompts'

/** The languages a rebuilt page can be translated into. */
export interface RebuildTranslationTarget {
  /** The checkpoint label and artifacts folder name. */
  code: string
  prompt: string
  instruction(page: number): string
}

export const simplifiedChinese: RebuildTranslationTarget = {
  code: 'zh',
  prompt: RebuildPrompts.translateChinese,
  instruction: (page) => `Translate page ${page} into Simplified Chinese:\n`
}

export const TranslationPatterns = {
  protected: new Pattern(
    String.raw`\\begin\{verbatim\}.*?\\end\{verbatim\}|(?<!\\)\\\[.*?(?<!\\)\\\]|(?<!\\)\$(?:\\.|[^$\\])*\$`,
    { dotAll: true }
  ),
  token: new Pattern(String.raw`REBUILDPDFPROTECTED\d{4,}TOKEN`),
  digits: new Pattern(String.raw`\d+`),
  structure: new Pattern(
    String.raw`\\begin\{[^}]*\}(?:\{[\d.,\s]+\})?|\\end\{[^}]*\}|\\columnbreak\b|\\nextside\b|\\rebuildfigure\{f\d+\}`
  ),
  typewriter: new Pattern(String.raw`\\texttt\{`),
  paragraphBreak: new Pattern(String.raw`\n\s*\n`),
  startsUnindented: new Pattern(String.raw`\s*\\noindent\b`),
  leadingNoindent: new Pattern(String.raw`^\s*\\noindent\b[ \t]*`),
  columnBreak: new Pattern(String.raw`[ \t]*\\columnbreak(?![A-Za-z])[ \t]*`),
  sentenceEnd: new Pattern(String.raw`[.!?:;。！？：；…”’」』)）][\s}]*$`),
  heading: new Pattern(String.raw`\s*\\text(?:bf|sc)\{.*\}\s*`),
  closing: new Pattern(String.raw`\s*(?:\\end\{[^}]*\}\s*)+`)
}

function token(index: number): string {
  return `REBUILDPDFPROTECTED${String(index).padStart(4, '0')}TOKEN`
}

/** `protect_markup`: keep math and code out of the translator, then restore them byte for byte. */
export function protectMarkup(source: PageMarkup): { text: string; protected: string[] } {
  const text = source.serialize()
  if (TranslationPatterns.token.contains(text)) throw new MarkupError('source contains a reserved translation token')
  const spans: Array<[number, number]> = TranslationPatterns.protected.matches(text).map((match) => [match.start, match.end])
  // Inline typewriter code can contain nested braces and escaped literal braces.
  for (const match of TranslationPatterns.typewriter.matches(text)) {
    const start = match.start
    const end = closingBrace(text, match.end) ?? text.length
    if (!spans.some(([first, last]) => first <= start && start < last)) spans.push([start, end])
  }
  spans.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])
  let output = ''
  const protectedSpans: string[] = []
  let previous = 0
  for (const [first, last] of spans) {
    if (first < previous) continue
    output += text.slice(previous, first)
    output += token(protectedSpans.length)
    protectedSpans.push(text.slice(first, last))
    previous = last
  }
  output += text.slice(previous)
  return { text: output, protected: protectedSpans }
}

function sortedStrings(values: string[]): string[] {
  return [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** `restore_translation`: put math and code back and check that the page kept its structure. */
export function restoreTranslation(raw: string, protectedSpans: readonly string[], source: PageMarkup): PageMarkup {
  const expected = protectedSpans.map((_, index) => token(index))
  // Chinese word order may move a formula within its sentence, so order is not checked here.
  const found = TranslationPatterns.token.findAll(raw)
  if (!sameStrings(sortedStrings(found), expected)) {
    const counts = new Map<string, number>()
    for (const item of found) counts.set(item, (counts.get(item) ?? 0) + 1)
    const missing = expected.filter((item) => !counts.has(item))
    const repeated = expected.filter((item) => (counts.get(item) ?? 0) > 1)
    const unknown = sortedStrings([...new Set(found)].filter((item) => !expected.includes(item)))
    const problems = ([['missing', missing], ['repeated', repeated], ['unknown', unknown]] as Array<[string, string[]]>)
      .filter(([, items]) => items.length)
      .map(([name, items]) => `${name} ${items.join(', ')}`)
    throw new MarkupError(`math/code tokens were omitted, duplicated or changed (${problems.join('; ')}); copy each token exactly once`)
  }
  // Substitute in one pass so literal contents cannot be interpreted as replacement syntax.
  const text = TranslationPatterns.token.sub(raw, (match) => protectedSpans[Number(TranslationPatterns.digits.search(match.text)!.text)])
  const target = PageMarkup.parse(stripFences(text))
  if (target.font !== source.font || target.columns !== source.columns || !target.figures.equals(source.figures)) {
    throw new MarkupError('translation changed the page font, columns or figure boxes')
  }
  for (const [name, before, after] of [['header', source.header, target.header], ['body', source.body, target.body], ['footer', source.footer, target.footer]]) {
    if (!sameStrings(TranslationPatterns.structure.findAll(before), TranslationPatterns.structure.findAll(after))) {
      throw new MarkupError(`translation changed the ${name} environment, column or figure order`)
    }
    // Tokens must stay in their section and paragraph; within a paragraph they follow the prose.
    if (!sameStrings(sortedStrings(TranslationPatterns.protected.findAll(after)), sortedStrings(TranslationPatterns.protected.findAll(before)))) {
      throw new MarkupError(`translation changed or moved mathematics/code in ${name}`)
    }
    // A paragraph count that pairing cannot explain is reported by alignTranslationParagraphs.
    const pairing = pairParagraphs(before, after)
    if (pairing) {
      for (const group of pairing.groups) {
        if (!sameStrings(mathematics(pairing.before, group), mathematics(pairing.after, group.map((index) => pairing.targets[index])))) {
          throw new MarkupError(`translation moved mathematics/code out of paragraph ${group[0] + 1} in ${name}; `
            + 'keep each formula in the paragraph it came from')
        }
      }
    }
  }
  target.notes = [...source.notes]
  return alignTranslationParagraphs(source, target)
}

/**
 * `align_translation_paragraphs`: keep paragraph boundaries, column breaks and first-line indentation
 * under local control.
 */
export function alignTranslationParagraphs(source: PageMarkup, translated: PageMarkup): PageMarkup {
  const target = translated.clone()
  for (const section of ['body', 'footer'] as const) {
    const pairing = pairParagraphs(section === 'body' ? source.body : source.footer, section === 'body' ? target.body : target.footer)
    if (!pairing) throw new MarkupError(`translation changed the number of paragraphs in ${section}; preserve blank-line boundaries`)
    const after = [...pairing.after]
    pairing.before.forEach((original, position) => {
      const index = pairing.targets[position]
      if (index === undefined) return
      const unindented = TranslationPatterns.startsUnindented.match(original) !== undefined
      const text = TranslationPatterns.leadingNoindent.sub(after[index], '')
      after[index] = (unindented ? '\\noindent ' : '') + text
    })
    target[section] = after.join('\n\n')
  }
  return target
}

function isColumnBreak(paragraph: string): boolean {
  return PythonText.strip(paragraph) === '\\columnbreak'
}

/** `_paragraphs`: blank-line paragraphs; a bare `\end{...}` closes the text paragraph before it. */
function paragraphs(text: string): string[] {
  const result: string[] = []
  for (const paragraph of TranslationPatterns.paragraphBreak.split(text)) {
    const last = result.at(-1)
    if (last !== undefined && !isColumnBreak(last) && TranslationPatterns.closing.fullMatch(paragraph) !== undefined) {
      result[result.length - 1] += `\n${PythonText.lstrip(paragraph)}`
    } else {
      result.push(paragraph)
    }
  }
  return result
}

function mathematics(items: readonly string[], indices: ReadonlyArray<number | undefined>): string[] {
  return sortedStrings(indices.flatMap((index) => index === undefined ? [] : TranslationPatterns.protected.findAll(items[index])))
}

interface ParagraphPairing {
  /** The source paragraphs. */
  before: string[]
  /** The translated paragraphs in source order, with the source's column breaks. */
  after: string[]
  /** The translated paragraph each source paragraph became (undefined: merged away). */
  targets: Array<number | undefined>
  /** Source paragraphs whose mathematics must stay together. */
  groups: number[][]
}

/**
 * `_pair_paragraphs`: pair source paragraphs with their translations, with column breaks back in
 * their source places.
 *
 * A standalone column break is layout, like indentation: the translator may move it, so it
 * returns to where the source had it. A sentence that such a break splits into two
 * paragraphs is one sentence to the translator: Chinese word order may carry its
 * continuation, formulas included, ahead of the break, and a continuation emptied that way
 * disappears. Other paragraphs pair one to one. Undefined when the paragraph count cannot be
 * explained this way.
 */
function pairParagraphs(source: string, translation: string): ParagraphPairing | undefined {
  const before = paragraphs(source)
  const after = TranslationPatterns.paragraphBreak.split(translation)
  const breaks = before.map(isColumnBreak)
  const texts = after.filter((paragraph) => !isColumnBreak(paragraph))
  if (breaks.filter(Boolean).length !== after.length - texts.length) return undefined
  const translated = paragraphs(texts.join('\n\n'))
  const sources = before.map((_, index) => index).filter((index) => !breaks[index])
  const splits = sources.length < 2 ? [] : Array.from({ length: sources.length - 1 }, (_, n) => n).filter((n) =>
    sources[n + 1] - sources[n] > 1 && sentenceContinues(
      PythonText.rstrip(before[sources[n]]).split('\n').at(-1)!,
      PythonText.lstrip(before[sources[n + 1]]).split('\n')[0]
    ))
  const dropped = sources.length - translated.length
  if (!(dropped >= 0 && dropped <= splits.length)) return undefined
  const groups: number[][] = []
  sources.forEach((index, n) => {
    if (splits.includes(n - 1)) groups[groups.length - 1].push(index)
    else groups.push([index])
  })
  // itertools.combinations(splits, dropped), in the same order; the first that keeps the
  // mathematics wins, otherwise the error is reported against the first.
  let first: ParagraphPairing | undefined
  const chosen = Array.from({ length: dropped }, (_, index) => index)
  for (;;) {
    const gone = chosen.map((index) => splits[index])
    const paired: string[] = []
    const targets: Array<number | undefined> = []
    let n = 0
    before.forEach((paragraph, index) => {
      let kept: string | undefined = paragraph
      if (!breaks[index]) {
        kept = gone.includes(n - 1) ? undefined : translated[n - gone.filter((value) => value < n).length]
        n += 1
      }
      targets.push(kept === undefined ? undefined : paired.length)
      if (kept !== undefined) paired.push(kept)
    })
    const pairing: ParagraphPairing = { before, after: paired, targets, groups }
    if (groups.every((group) => sameStrings(mathematics(before, group), mathematics(paired, group.map((index) => targets[index]))))) return pairing
    first ??= pairing
    let position = -1
    for (let index = chosen.length - 1; index >= 0; index -= 1) {
      if (chosen[index] < splits.length - dropped + index) {
        position = index
        break
      }
    }
    if (position < 0) break
    chosen[position] += 1
    for (let later = position + 1; later < chosen.length; later += 1) chosen[later] = chosen[later - 1] + 1
  }
  return first
}

/** `columns_level`: did both columns of a two-column scan run to the same depth (within three printed lines)? */
export function columnsLevel(measure: PageMeasure): boolean {
  const bottoms = measure.columnBottoms
  if (!bottoms || bottoms.length !== 2) return false
  return Math.abs(bottoms[0] - bottoms[1]) <= 3 * (measure.pitch ?? 12)
}

/**
 * `release_column_breaks`: let a translation whose source columns end level flow between its columns.
 *
 * A printed column break falls wherever the source text reached the column foot, often
 * mid-sentence. Shorter Chinese text kept to that break leaves one column half empty, and
 * an overlong one shrinks the whole page. A column that ends short by design, and pages
 * with figures that balancing could move between columns, keep their breaks.
 */
export function releaseColumnBreaks(markup: PageMarkup, measure: PageMeasure): PageMarkup {
  if (!columnsLevel(measure) || markup.body.includes('\\rebuildfigure')) return markup
  const rows = markup.body.split('\n')
  const contexts = lineContexts(rows)
  const output: string[] = []
  let index = 0
  while (index < rows.length) {
    let end: number | undefined
    if (PythonText.strip(rows[index]) === '\\begin{multicols}{2}') {
      for (let row = index + 1; row < rows.length; row += 1) {
        if (PythonText.strip(rows[row]) === '\\end{multicols}') {
          end = row
          break
        }
      }
    }
    const breaks: number[] = []
    if (end !== undefined) {
      for (let row = index + 1; row < end; row += 1) if (rows[row].includes('\\columnbreak') && contexts[row].environment !== 'verbatim') breaks.push(row)
    }
    if (end !== undefined && breaks.length === 1) {
      output.push(...flowColumns(rows.slice(index, end + 1), breaks[0] - index))
      index = end + 1
      continue
    }
    if (!rows[index].includes('\\columnbreak') || contexts[index].environment === 'verbatim') output.push(rows[index])
    else if (PythonText.strip(rows[index]) !== '\\columnbreak') output.push(TranslationPatterns.columnBreak.sub(rows[index], ''))
    index += 1
  }
  const released = markup.clone()
  released.body = output.join('\n')
  return released
}

/** `_continues`: does the sentence on a column's last line run on into the next column's first line? */
function sentenceContinues(last: string, first: string): boolean {
  return !TranslationPatterns.sentenceEnd.contains(last) && TranslationPatterns.heading.fullMatch(last) === undefined
    && LineRules.blockLine.match(last) === undefined && LineRules.styleOnly.fullMatch(last) === undefined
    && LineRules.blockLine.match(first) === undefined
}

/**
 * `_flow`: a two-column block without its break (at): the halves rejoin and balance.
 *
 * A note under a rule that closes the first column, such as a first-page footnote, stays
 * at that column's foot while the text flows past it. A sentence split by the break is
 * one paragraph again, even where the transcription set the break between blank lines.
 */
function flowColumns(rows: readonly string[], at: number): string[] {
  const blank = (row: string): boolean => !PythonText.strip(row)
  let left = rows.slice(1, at)
  const right = rows.slice(at + 1, rows.length - 1)
  if (PythonText.strip(rows[at]) !== '\\columnbreak') left.push(TranslationPatterns.columnBreak.sub(rows[at], ''))
  while (left.length && blank(left[left.length - 1])) left.pop()
  while (right.length && blank(right[0])) right.shift()
  let note: string[] = []
  while (left.length) {
    let lastBlank = -1
    for (let index = left.length - 1; index >= 0; index -= 1) {
      if (blank(left[index])) {
        lastBlank = index
        break
      }
    }
    const start = lastBlank + 1
    if (!left.slice(start).join('\n').includes('\\rule')) break
    note = [...left.slice(start), ...(note.length ? ['', ...note] : [])]
    left = left.slice(0, start)
    while (left.length && blank(left[left.length - 1])) left.pop()
  }
  const continues = left.length && right.length ? sentenceContinues(left[left.length - 1], right[0]) : false
  // A standalone break ended its paragraph; only a sentence it split runs on.
  const text = [...left, ...(continues ? [] : ['']), ...right]
  if (note.length) return ['\\rebuildcolumnnote{%', ...note, '}', '\\begin{rebuildflow}', ...text, '\\end{rebuildflow}']
  return [rows[0], ...text, rows[rows.length - 1]]
}

/**
 * `translate_markup`: translate one page, sending protection and layout errors back to the model.
 *
 * Like `requestMarkup`, saved answers that still fail are followed by a fresh request.
 */
export async function translateMarkup(
  model: CheckpointedModel, page: number, source: PageMarkup, language: RebuildTranslationTarget,
  validate: (markup: PageMarkup) => Promise<void>
): Promise<{ markup: PageMarkup; usage: RebuildUsage }> {
  const { text, protected: protectedSpans } = protectMarkup(source)
  const label = `translate-${language.code}-page-${String(page).padStart(4, '0')}`
  const messages = [textMessage('system', language.prompt), textMessage('user', language.instruction(page) + text)]
  const replayed = await model.hasCheckpoint(label, messages)
  try {
    return await translationAttempts(model, label, page, source, protectedSpans, messages, validate)
  } catch (error) {
    if (!(replayed && error instanceof RebuildError && error.reason.kind === 'unusableModelOutput')) throw error
    return translationAttempts(model.refreshing(), label, page, source, protectedSpans, messages, validate)
  }
}

async function translationAttempts(
  model: CheckpointedModel, label: string, page: number, source: PageMarkup, protectedSpans: readonly string[],
  initial: RebuildMessage[], validate: (markup: PageMarkup) => Promise<void>
): Promise<{ markup: PageMarkup; usage: RebuildUsage }> {
  const messages = [...initial]
  let usage = emptyUsage()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { text: raw, usage: spent } = await model.chat(label, messages)
    usage = addUsage(usage, spent)
    let problem: string
    try {
      const target = restoreTranslation(raw, protectedSpans, source)
      await validate(target)
      return { markup: target, usage }
    } catch (error) {
      if (!(error instanceof MarkupError || error instanceof LatexError)) throw error
      problem = error.message
    }
    if (attempt === 2) throw new RebuildError({ kind: 'unusableModelOutput', page, stage: 'translating', detail: problem })
    messages.push(
      textMessage('assistant', raw),
      textMessage('user', 'Fix this error and return the complete translated <page>, '
        + `still using the original protected tokens: ${problem}`)
    )
  }
  throw new Error('unreachable')
}
