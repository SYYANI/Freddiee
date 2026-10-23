import { InkMask, type RGBImage } from './bitmap'
import { type OcrLine, type PageLayout, type PageMeasure, lineHeight } from './geometry'
import { type LineFrame, LineRules, lineContexts, sameFrames } from './lineBreaks'
import type { PageMarkup } from './markup'
import { Pattern, PythonNumber, PythonText, compareTuples } from './pattern'

const CoveragePatterns = {
  token: new Pattern(String.raw`[㐀-鿿豈-﫿]|[^\W\d_㐀-鿿豈-﫿]{2,}`),
  softHyphenBreak: new Pattern(String.raw`\\-\s*\n\s*`),
  command: new Pattern(String.raw`\\[A-Za-z]+\*?`),
  escape: new Pattern(String.raw`\\.`),
  multicolsBegin: new Pattern(String.raw`\s*\\begin\{multicols\}\{(\d)\}`),
  openingNoise: new Pattern(String.raw`[{}$\s]+`),
  multicolsEnd: new Pattern(String.raw`\s*\\end\{multicols\}`),
  columnBreak: new Pattern(String.raw`[ \t]*\\columnbreak(?![A-Za-z])[ \t]*`)
}

/** Full case folding beyond `toLowerCase`, as Foundation's case-insensitive folding does. */
function caseFold(text: string): string {
  return text.toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ').replaceAll('ﬅ', 'st').replaceAll('ﬆ', 'st')
}

/** `_tokens`: words for comparing a transcription with OCR (single CJK characters count as words). */
export function coverageTokens(text: string): string[] {
  return CoveragePatterns.token.findAll(caseFold(text.normalize('NFKC')))
}

/** `markup_plain`: the page text without LaTeX commands. */
export function markupPlain(markup: PageMarkup): string {
  return plainText([markup.header, markup.body, markup.footer].join('\n'))
}

/** `_plain`: LaTeX source without commands and escapes. */
export function plainText(source: string): string {
  let text = CoveragePatterns.softHyphenBreak.sub(source, '')
  text = CoveragePatterns.command.sub(text, ' ')
  return CoveragePatterns.escape.sub(text, ' ')
}

function counted(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function total(counts: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const value of counts.values()) sum += value
  return sum
}

function shared(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const [key, value] of a) sum += Math.min(value, b.get(key) ?? 0)
  return sum
}

/** `coverage_warnings`: flag scanned lines whose word pairs are absent from the transcription. */
export function coverageWarnings(markup: PageMarkup, lines: readonly OcrLine[], imageSize?: { width: number; height: number }): string[] {
  const words = coverageTokens(markupPlain(markup))
  const vocabulary = new Set(words)
  const pairs = new Set(words.slice(1).map((word, index) => `${words[index]}\u0000${word}`))
  const canonical = new Map<string, string>()

  const canon = (word: string): string => {
    if (vocabulary.has(word) || PythonText.length(word) < 3) return word
    const known = canonical.get(word)
    if (known !== undefined) return known
    const close = closeMatch(word, vocabulary, 0.75) ?? word
    canonical.set(word, close)
    return close
  }

  const warnings: string[] = []
  for (const line of lines) {
    if (line.confidence < 50) continue
    if (imageSize && lineInFigures(line, markup, imageSize)) continue
    const tokens = coverageTokens(line.text).map(canon)
    const bigrams = tokens.slice(1).map((token, index) => `${tokens[index]}\u0000${token}`)
    // OCR of formulas yields short junk tokens; only judge lines with real words.
    const wordLike = tokens.filter((token) => PythonText.length(token) >= 4 || PythonText.length(token) === 1).length
    if (wordLike < 3) continue
    if (bigrams.length >= 3 && bigrams.filter((bigram) => pairs.has(bigram)).length / bigrams.length < 0.34) {
      warnings.push(`OCR line not found in the markup, possibly omitted: ${PythonText.repr(line.text)}`)
    }
  }
  const counts = new Map<string, number>()
  for (const line of PythonText.splitLines(markup.body)) {
    const stripped = PythonText.strip(line)
    if (PythonText.length(stripped) <= 25) continue
    counts.set(stripped, (counts.get(stripped) ?? 0) + 1)
  }
  for (const [line, count] of counts) if (count > 1) warnings.push(`line occurs ${count} times, possibly duplicated: ${PythonText.repr(line)}`)
  return warnings
}

/**
 * `place_column_breaks`: move misplaced \\columnbreak to where the scan's columns actually split.
 *
 * With one source line per printed line, each line of a block of columns is matched to
 * the OCR line it was read from, which lies in one of the scan's columns. The breaks go
 * where the fewest matched lines would land in the wrong column. They only move when that
 * is clearly better than where the model put them: a break is often read correctly and
 * shifted to a nearby paragraph boundary, and that cost is several lines at once.
 */
export function placeColumnBreaks(
  markup: PageMarkup, lines: readonly OcrLine[], measure: PageMeasure, imageSize: { width: number; height: number }
): { markup: PageMarkup; note?: string } {
  const count = measure.columns.length
  if (count < 2) return { markup }
  const factor = imageSize.width / measure.pageWidth
  const bounds = [-Infinity, ...measure.columns.slice(1).map((column, index) => (measure.columns[index][1] + column[0]) / 2 * factor), Infinity]
  const scanned: Array<{ tokens: Map<string, number>; side: number }> = []
  for (const line of lines) {
    const tokens = coverageTokens(line.text)
    let side: number | undefined
    for (let index = 0; index + 1 < bounds.length; index += 1) {
      if (bounds[index] < line.left && line.right < bounds[index + 1]) {
        side = index
        break
      }
    }
    if (line.confidence >= 50 && tokens.length && side !== undefined) scanned.push({ tokens: counted(tokens), side })
  }

  const column = (text: string): number | undefined => {
    const tokens = counted(coverageTokens(plainText(text)))
    const size = total(tokens)
    if (!(size > 0)) return undefined
    const scores = scanned.map((seen) => ({ score: shared(tokens, seen.tokens) / Math.max(size, total(seen.tokens)), side: seen.side }))
      .sort((a, b) => a.score !== b.score ? b.score - a.score : b.side - a.side)
    const top = scores[0]
    if (!top || top.score < 0.6) return undefined
    // A short line ("sake.") identifies its column only when no other line matches as well.
    if (size < 3 && scores.length > 1 && scores[1].score === top.score && scores[1].side !== top.side) return undefined
    return top.side
  }

  const blockEnd = (rows: readonly string[], after: number): number | undefined => {
    for (let index = after + 1; index < rows.length; index += 1) if (CoveragePatterns.multicolsEnd.match(rows[index])) return index
    return undefined
  }

  let rows = markup.body.split('\n')
  let contexts = lineContexts(rows)
  let note: string | undefined
  let index = 0
  while (index < rows.length) {
    // Only a block of the page's own columns, not columns nested in a side-by-side block.
    const opening = CoveragePatterns.multicolsBegin.match(rows[index])
    if (!opening || Number(opening.at(1)) !== count || contexts[index].frames.length) {
      index += 1
      continue
    }
    let end = blockEnd(rows, index)
    if (end === undefined) break
    const block = Array.from({ length: end - index - 1 }, (_, offset) => index + 1 + offset)
    const breaks = block.filter((row) => rows[row].includes('\\columnbreak') && contexts[row].environment !== 'verbatim')
    const printed = block.filter((row) => contexts[row].breakable && PythonText.strip(rows[row]) !== '\\columnbreak')
    if (breaks.length === count - 1 && printed.length) {
      const labels = printed.map((row) => column(rows[row].replaceAll('\\columnbreak', '')))
      // A break attached to a line's end falls after that line.
      const current = breaks.map((mark) => printed.filter((row) => row < mark || (row === mark && PythonText.strip(rows[row]) !== '\\columnbreak')).length)
      // Lines up to each position that were read in each column, and that were placed at all.
      const seen = Array.from({ length: count }, () => new Array<number>(printed.length + 1).fill(0))
      const known = new Array<number>(printed.length + 1).fill(0)
      labels.forEach((label, position) => {
        for (let side = 0; side < count; side += 1) seen[side][position + 1] = seen[side][position] + (label === side ? 1 : 0)
        known[position + 1] = known[position] + (label === undefined ? 0 : 1)
      })

      const errors = (splits: readonly number[]): number => {
        const edges = [0, ...splits, printed.length]
        let sum = 0
        for (let side = 0; side + 1 < edges.length; side += 1) {
          const [a, b] = [edges[side], edges[side + 1]]
          sum += known[b] - known[a] - seen[side][b] + seen[side][a]
        }
        return sum
      }
      const distance = (splits: readonly number[]): number => splits.reduce((sum, split, position) => sum + Math.abs(split - current[position]), 0)

      // itertools.combinations_with_replacement(range(len(printed) + 1), count - 1), first minimum.
      const candidate = new Array<number>(count - 1).fill(0)
      let best = [...candidate]
      for (;;) {
        if (compareTuples([errors(candidate), distance(candidate)], [errors(best), distance(best)]) < 0) best = [...candidate]
        let position = -1
        for (let item = candidate.length - 1; item >= 0; item -= 1) {
          if (candidate[item] < printed.length) {
            position = item
            break
          }
        }
        if (position < 0) break
        const raised = candidate[position] + 1
        for (let later = position; later < candidate.length; later += 1) candidate[later] = raised
      }
      if (errors(current) - errors(best) >= 3 && errors(best) <= Math.max(1, Math.trunc(known[printed.length] / 10))) {
        const targets = best.map((split) => split < printed.length ? printed[split] : end!)
        const moved: string[] = []
        rows.forEach((text, row) => {
          for (const target of targets) if (target === row) moved.push('\\columnbreak')
          if (breaks.includes(row)) {
            if (PythonText.strip(text) === '\\columnbreak') return
            moved.push(CoveragePatterns.columnBreak.sub(text, ''))
          } else {
            moved.push(text)
          }
        })
        const openings = targets.map((target, position) => {
          const first = best[position] < printed.length ? rows[target] : ''
          return `“${PythonText.prefix(PythonText.strip(plainText(first)), 40)}”`
        })
        note = '按 OCR 分栏位置移动 \\columnbreak，'
          + (count === 2 ? `右栏从${openings[0]}开始` : `后续各栏分别从${openings.join('、')}开始`)
        rows = moved
        contexts = lineContexts(rows)
        end = blockEnd(rows, index)!
      }
    }
    index = end + 1
  }
  if (note === undefined) return { markup }
  const placed = markup.clone()
  placed.body = rows.join('\n')
  return { markup: placed, note }
}

/**
 * `restore_vertical_gaps`: give two printed lines the blank space the scan leaves between them,
 * where the markup gives none.
 *
 * Each printed line of the body is matched to the OCR line it was read from. Where two lines
 * that follow each other in one column and one environment stand further apart on the scan
 * than the line pitch and paragraph spacing explain, and the scan is blank between them, a
 * \vspace goes before the second: headings and title lines keep their separation when the
 * transcription omits it. Space the markup already gives, displays and figures are left alone.
 */
export function restoreVerticalGaps(
  markup: PageMarkup, lines: readonly OcrLine[], measure: PageMeasure, layout: PageLayout, image: RGBImage
): { markup: PageMarkup; note?: string } {
  const scale = image.width / measure.pageWidth
  const pitch = (measure.pitch !== undefined && measure.pitch !== 0 ? measure.pitch : layout.leading) * scale
  const rows = markup.body.split('\n')
  const contexts = lineContexts(rows)
  const scanned = lines.flatMap((line, index) => {
    const tokens = coverageTokens(line.text)
    return line.confidence >= 50 && tokens.length ? [{ tokens: counted(tokens), index }] : []
  })
  const heights = scanned.filter((entry) => total(entry.tokens) >= 3).map((entry) => lineHeight(lines[entry.index])).sort((a, b) => a - b)
  const usual = heights.length ? heights[Math.trunc(heights.length / 2)] : pitch * 0.7
  const ink = new InkMask(image)
  const { width, height } = image
  const figures = markup.figures.entries.map(({ box }) => [box.x0 * width / 1000, box.y0 * height / 1000, box.x1 * width / 1000, box.y1 * height / 1000])

  const source = (text: string): number | undefined => {
    const tokens = counted(coverageTokens(plainText(text)))
    const size = total(tokens)
    if (!(size > 0)) return undefined
    const scores = scanned.map((seen, position) => ({ score: shared(tokens, seen.tokens) / Math.max(size, total(seen.tokens)), position }))
      .sort((a, b) => a.score !== b.score ? b.score - a.score : b.position - a.position)
    // A line read as well from two places on the page is not placed.
    const top = scores[0]
    if (!top || top.score < 0.6 || (scores.length > 1 && scores[1].score === top.score)) return undefined
    return scanned[top.position].index
  }

  const blank = (upper: number, lower: number): boolean => {
    const a = lines[upper]
    const b = lines[lower]
    const x0 = Math.min(a.left, b.left)
    const x1 = Math.max(a.right, b.right)
    const y0 = a.bottom + 2
    const y1 = b.top - 2
    if (y1 <= y0 || lines.some((line, index) => index !== upper && index !== lower && line.left < x1 && x0 < line.right
      && y0 < (line.top + line.bottom) / 2 && (line.top + line.bottom) / 2 < y1)) return false
    if (figures.some((box) => box[0] < x1 && x0 < box[2] && box[1] < y1 && y0 < box[3])) return false
    const [left, top, right, bottom] = [PythonNumber.round(x0), PythonNumber.round(y0), PythonNumber.round(x1), PythonNumber.round(y1)]
    return ink.count(left, top, right, bottom) <= Math.max(4, Math.trunc((right - left) * (bottom - top) / 1000))
  }

  const inserts: Array<{ index: number; amount: number }> = []
  let previous: { index: number; frames: LineFrame[]; line: number } | undefined
  rows.forEach((row, index) => {
    if (!PythonText.strip(row)) return
    const { breakable, environment, frames } = contexts[index]
    const line = breakable ? source(row) : undefined
    if (previous && line !== undefined) {
      const a = lines[previous.line]
      const b = lines[line]
      const separated = index - previous.index > 1
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      if (sameFrames(frames, previous.frames) && (separated || LineRules.lineEnvironments.has(environment)) && a.bottom < b.top
        && overlap > 0.3 * Math.min(a.right - a.left, b.right - b.left)) {
        const step = (b.top + b.bottom - a.top - a.bottom) / 2
        // Centre to centre: two lines of their printed heights with the page's usual
        // space between lines, whatever size the markup gives them.
        const expected = (lineHeight(a) + lineHeight(b)) / 2 + pitch - usual + (separated ? layout.paragraphGap * scale : 0)
        const amount = PythonNumber.round((step - expected) / pitch * 4) / 4
        if (amount >= 0.5 && blank(previous.line, line)) inserts.push({ index, amount })
      }
    }
    previous = line !== undefined ? { index, frames, line } : undefined
  })
  if (!inserts.length) return { markup }
  const places = inserts.slice(0, 3).map((insert) => {
    const plain = PythonText.strip(CoveragePatterns.openingNoise.sub(plainText(rows[insert.index]), ' '))
    return `“${PythonText.prefix(plain, 24)}”前 ${PythonNumber.general(insert.amount)} 行`
  }).join('、')
  for (const insert of [...inserts].reverse()) rows.splice(insert.index, 0, `\\vspace{${PythonNumber.general(insert.amount)}\\baselineskip}`)
  const spaced = markup.clone()
  spaced.body = rows.join('\n')
  return { markup: spaced, note: `按原稿补回 ${inserts.length} 处竖向间距：${places}${inserts.length > 3 ? '等' : ''}` }
}

export function lineInFigures(line: OcrLine, markup: PageMarkup, imageSize: { width: number; height: number }): boolean {
  const x0 = line.left * 1000 / imageSize.width
  const y0 = line.top * 1000 / imageSize.height
  const x1 = line.right * 1000 / imageSize.width
  const y1 = line.bottom * 1000 / imageSize.height
  const area = (x1 - x0) * (y1 - y0)
  return area > 0 && markup.figures.entries.some(({ box }) =>
    Math.max(0, Math.min(x1, box.x1) - Math.max(x0, box.x0)) * Math.max(0, Math.min(y1, box.y1) - Math.max(y0, box.y0)) >= area * 0.8)
}

/** Code point comparison of strings, as Swift compares arrays of Unicode scalars. */
function compareScalars(a: readonly number[], b: readonly number[]): number {
  return compareTuples(a, b)
}

/** `difflib.get_close_matches(word, possibilities, n=1, cutoff=cutoff)`. */
export function closeMatch(word: string, possibilities: ReadonlySet<string>, cutoff: number): string | undefined {
  const target = Array.from(word, (scalar) => scalar.codePointAt(0)!)
  let best: { score: number; scalars: number[]; text: string } | undefined
  for (const candidate of possibilities) {
    const scalars = Array.from(candidate, (scalar) => scalar.codePointAt(0)!)
    const matcher = new SequenceMatcher(scalars, target)
    if (!(matcher.realQuickRatio() >= cutoff && matcher.quickRatio() >= cutoff)) continue
    const score = matcher.ratio()
    if (!(score >= cutoff)) continue
    // heapq.nlargest on (score, candidate): ties go to the larger string.
    if (best && (score < best.score || (score === best.score && !(compareScalars(best.scalars, scalars) < 0)))) continue
    best = { score, scalars, text: candidate }
  }
  return best?.text
}

/** `difflib.SequenceMatcher` without junk heuristics (inputs here are single words). */
export class SequenceMatcher {
  private readonly b2j = new Map<number, number[]>()

  constructor(readonly a: readonly number[], readonly b: readonly number[]) {
    b.forEach((element, index) => {
      const list = this.b2j.get(element)
      if (list) list.push(index)
      else this.b2j.set(element, [index])
    })
    // autojunk only applies to sequences of 200 or more elements.
    if (b.length >= 200) {
      const popular = Math.trunc(b.length / 100) + 1
      for (const [element, indices] of [...this.b2j]) if (indices.length > popular) this.b2j.delete(element)
    }
  }

  realQuickRatio(): number {
    return SequenceMatcher.ratioOf(Math.min(this.a.length, this.b.length), this.a.length + this.b.length)
  }

  quickRatio(): number {
    const available = new Map<number, number>()
    for (const element of this.b) available.set(element, (available.get(element) ?? 0) + 1)
    let matches = 0
    for (const element of this.a) {
      const count = available.get(element)
      if (count !== undefined && count > 0) {
        available.set(element, count - 1)
        matches += 1
      }
    }
    return SequenceMatcher.ratioOf(matches, this.a.length + this.b.length)
  }

  ratio(): number {
    return SequenceMatcher.ratioOf(this.matchingBlocks().reduce((sum, block) => sum + block.size, 0), this.a.length + this.b.length)
  }

  private static ratioOf(matches: number, length: number): number {
    return length > 0 ? 2 * matches / length : 1
  }

  matchingBlocks(): Array<{ i: number; j: number; size: number }> {
    const queue: Array<[number, number, number, number]> = [[0, this.a.length, 0, this.b.length]]
    const blocks: Array<{ i: number; j: number; size: number }> = []
    for (let next = queue.pop(); next; next = queue.pop()) {
      const [alo, ahi, blo, bhi] = next
      const [i, j, k] = this.longestMatch(alo, ahi, blo, bhi)
      if (!(k > 0)) continue
      blocks.push({ i, j, size: k })
      if (alo < i && blo < j) queue.push([alo, i, blo, j])
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
    }
    return blocks.sort((x, y) => compareTuples([x.i, x.j], [y.i, y.j]))
  }

  private longestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    let [besti, bestj, bestsize] = [alo, blo, 0]
    let j2len = new Map<number, number>()
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>()
      for (const j of this.b2j.get(this.a[i]) ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        newj2len.set(j, k)
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k]
      }
      j2len = newj2len
    }
    // No junk: extend over equal neighbours that the popularity filter dropped.
    while (besti > alo && bestj > blo && this.a[besti - 1] === this.b[bestj - 1]) [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1]
    while (besti + bestsize < ahi && bestj + bestsize < bhi && this.a[besti + bestsize] === this.b[bestj + bestsize]) bestsize += 1
    return [besti, bestj, bestsize]
  }
}
