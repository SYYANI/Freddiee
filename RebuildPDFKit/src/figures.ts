import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { GrayImage, InkMask, type RGBImage } from './bitmap'
import { LatexError } from './errors'
import { atomicWriteFile } from '../../electron/main/files'
import type { OcrLine, PageLayout } from './geometry'
import { type LineFrame, lineContexts, sideWidths } from './lineBreaks'
import { type FigureBoxes, MarkupPatterns, type PageMarkup } from './markup'
import { type PDFPage, pageSize, renderPage } from './pdf'
import { Pattern, PythonNumber, PythonText, compareTuples } from './pattern'
import type { FigurePlacement } from './texSource'

export type FigurePixelBox = [number, number, number, number]

/** Closed frames, allowing thin, broken or slightly skewed scan rules. Captions stay outside. */
export function figureFrames(image: RGBImage): FigurePixelBox[] {
  const { width, height } = image
  const gray = image.grayscale()
  const ink = (index: number): boolean => gray[index] < 150
  const gap = Math.max(2, PythonNumber.round(width * 0.003))
  const tolerance = Math.max(3, PythonNumber.round(width * 0.01))
  const rules: FigurePixelBox[] = []
  for (let y = 0; y < height; y += 1) {
    let start = -1
    let last = -1
    for (let x = 0; x < width + gap + 1; x += 1) {
      if (x < width && ink(y * width + x)) {
        if (start < 0) start = x
        last = x
      } else if (start >= 0 && x - last > gap) {
        if (last - start >= width * 0.16) {
          let previous = -1
          for (let index = rules.length - 1; index >= 0; index -= 1) {
            if (y - rules[index][3] <= gap && Math.min(last + 1, rules[index][2]) - Math.max(start, rules[index][0]) >= -gap) {
              previous = index
              break
            }
          }
          if (previous >= 0) {
            const old = rules[previous]
            rules[previous] = [Math.min(old[0], start), old[1], Math.max(old[2], last + 1), y + 1]
          } else {
            rules.push([start, y, last + 1, y + 1])
          }
        }
        start = -1
      }
    }
  }
  const continuous = (x0: number, x1: number, y0: number, y1: number): boolean => {
    let empty = 0
    let occupied = 0
    const limit = Math.max(3, PythonNumber.round(height * 0.006))
    for (let y = y0; y < y1; y += 1) {
      let found = false
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
        if (ink(y * width + x)) {
          found = true
          break
        }
      }
      if (found) {
        empty = 0
        occupied += 1
      } else {
        empty += 1
        if (empty > limit) return false
      }
    }
    return occupied >= (y1 - y0) * 0.8
  }
  const candidates: FigurePixelBox[] = []
  rules.forEach((top, index) => {
    for (const bottom of rules.slice(index + 1)) {
      if (bottom[1] - top[3] < height * 0.035 || Math.abs(top[0] - bottom[0]) > tolerance || Math.abs(top[2] - bottom[2]) > tolerance) continue
      const left = Math.min(top[0], bottom[0])
      const right = Math.max(top[2], bottom[2])
      if (continuous(left - tolerance, left + tolerance + 1, top[1], bottom[3])
        && continuous(right - tolerance, right + tolerance + 1, top[1], bottom[3])) {
        candidates.push([left, top[1], right, bottom[3]])
      }
    }
  })
  const same = (a: FigurePixelBox, b: FigurePixelBox): boolean => a.every((value, index) => value === b[index])
  return candidates
    .filter((box) => !candidates.some((outer) => !same(box, outer) && outer[0] <= box[0] && outer[1] <= box[1] && outer[2] >= box[2] && outer[3] >= box[3]))
    .sort((a, b) => compareTuples([a[1], a[0]], [b[1], b[0]]))
}

/** Sequence alignment per column: match approximate boxes together, using each frame once. */
export function matchFigureFrames(
  boxes: ReadonlyArray<{ key: string; box: FigurePixelBox }>, frames: readonly FigurePixelBox[], width: number, height: number
): Map<string, FigurePixelBox> {
  const groups: FigurePixelBox[][] = []
  for (const frame of frames) {
    const index = groups.findIndex((group) => Math.abs(group[0][0] - frame[0]) <= width * 0.02 && Math.abs(group[0][2] - frame[2]) <= width * 0.02)
    if (index >= 0) groups[index].push(frame)
    else groups.push([frame])
  }
  const score = (box: FigurePixelBox, frame: FigurePixelBox): number => {
    const bw = box[2] - box[0]
    const bh = box[3] - box[1]
    const fw = frame[2] - frame[0]
    const fh = frame[3] - frame[1]
    const overlap = Math.max(0, Math.min(box[2], frame[2]) - Math.max(box[0], frame[0]))
    const distance = Math.abs((box[1] + box[3] - frame[1] - frame[3]) / 2)
    if (!(bw / fw >= 0.65 && bw / fw <= 1.5 && bh / fh >= 0.25 && bh / fh <= 2.0 && overlap >= Math.min(bw, fw) * 0.85 && distance <= height * 0.2)) return 0
    const intersection = overlap * Math.max(0, Math.min(box[3], frame[3]) - Math.max(box[1], frame[1]))
    if (!(intersection > 0)) return 0
    const union = bw * bh + fw * fh - intersection
    return 1 + intersection / union - distance / (height * 0.25)
  }
  const assigned: Array<Array<{ key: string; box: FigurePixelBox }>> = groups.map(() => [])
  for (const item of boxes) {
    const scores = groups.map((group) => Math.max(0, ...group.map((frame) => score(item.box, frame))))
    const best = Math.max(...scores, -Infinity)
    // Python's max chooses the first index on a tie.
    if (scores.length && best > 0) assigned[scores.indexOf(best)].push(item)
  }
  const matched = new Map<string, FigurePixelBox>()
  groups.forEach((frameGroup, index) => {
    const group = [...frameGroup].sort((a, b) => a[1] - b[1])
    const items = [...assigned[index]].sort((a, b) => a.box[1] - b.box[1])
    const n = items.length
    const m = group.length
    if (!(n > 0 && m > 0)) return
    const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        const fit = score(items[i].box, group[j])
        // Maximize the number of plausible matches before their geometric fit.
        const value = fit > 0 ? fit + (2 * n + 1) : 0
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], value > 0 ? value + dp[i + 1][j + 1] : 0)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      const fit = score(items[i].box, group[j])
      const value = fit > 0 ? fit + (2 * n + 1) : 0
      if (value > 0 && dp[i][j] === value + dp[i + 1][j + 1]) {
        matched.set(items[i].key, group[j])
        i += 1
        j += 1
      } else if (dp[i][j] === dp[i + 1][j]) {
        i += 1
      } else {
        j += 1
      }
    }
  })
  return matched
}

export function frameHints(image: RGBImage): string {
  const frames = figureFrames(image)
  if (!frames.length) return ''
  const boxes = frames.map((box) => box.map((value, index) => String(PythonNumber.round(value * 1000 / (index % 2 === 0 ? image.width : image.height)))).join(' '))
  return 'Detected closed frames, in WHOLE-PAGE 0–1000 coordinates (x0 y0 x1 y1):\n'
    + boxes.join('\n')
    + '\nCheck the scan: preserve each framed illustration, including code, as one complete figure; '
    + 'transcribe its caption separately. Do not also transcribe text inside a retained figure.'
}

function padFigureBox(box: FigurePixelBox, width: number, height: number): FigurePixelBox {
  const pad = Math.max(2, PythonNumber.round(Math.min(width, height) * 0.003)) * 2
  return [Math.max(0, box[0] - pad), Math.max(0, box[1] - pad), Math.min(width, box[2] + pad), Math.min(height, box[3] + pad)]
}

/**
 * `snap_figure_box`: grow a model box to strokes it cut through, stopping at blank gaps, then trim margins.
 *
 * Sideways the search reaches across a typed character's space, so a structure such as
 * "H - C - H" is not cut at its last atom; vertically it stops at the first blank band,
 * so neighbouring text lines are never swallowed.
 */
export function snapFigureBox(image: RGBImage, box: FigurePixelBox): FigurePixelBox {
  const frame = matchFigureFrames([{ key: 'f1', box }], figureFrames(image), image.width, image.height).get('f1')
  if (frame) return padFigureBox(frame, image.width, image.height)
  return snapUnframedBox(image, box)
}

function snapUnframedBox(image: RGBImage, box: FigurePixelBox): FigurePixelBox {
  const ink = new InkMask(image)
  const { width, height } = image
  const step = Math.max(2, PythonNumber.round(Math.min(width, height) * 0.003))
  const reach = Math.max(step, PythonNumber.round(width * 0.015))
  let [x0, y0, x1, y1] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(width, box[2]), Math.min(height, box[3])]
  const limits: FigurePixelBox = [
    x0 - PythonNumber.round(width * 0.1), y0 - PythonNumber.round(height * 0.04),
    x1 + PythonNumber.round(width * 0.1), y1 + PythonNumber.round(height * 0.04)
  ]
  ;[y0, y1] = dropTextBands(ink, [x0, y0, x1, y1], limits, reach)
  // An edge grows once a stroke crosses it; until then a blank edge row stays put.
  let up = false
  let down = false
  let changed = true
  while (changed) {
    changed = false
    if (x0 > Math.max(0, limits[0])) {
      const found = ink.boundingBox(Math.max(0, x0 - reach), y0, x0, y1)
      if (found) {
        x0 = Math.max(0, x0 - reach) + found.left
        changed = true
      }
    }
    if (x1 < Math.min(width, limits[2])) {
      const found = ink.boundingBox(x1, y0, Math.min(width, x1 + reach), y1)
      if (found) {
        x1 += found.right
        changed = true
      }
    }
    up = up || (y0 > 0 && ink.boundingBox(x0, y0 - 1, x1, y0) !== undefined)
    down = down || (y1 < height && ink.boundingBox(x0, y1, x1, y1 + 1) !== undefined)
    if (up && y0 > Math.max(0, limits[1]) && ink.boundingBox(x0, Math.max(0, y0 - step), x1, y0) !== undefined) {
      y0 = Math.max(0, y0 - step)
      changed = true
    }
    if (down && y1 < Math.min(height, limits[3]) && ink.boundingBox(x0, y1, x1, Math.min(height, y1 + step)) !== undefined) {
      y1 = Math.min(height, y1 + step)
      changed = true
    }
  }
  const tight = ink.boundingBox(x0, y0, x1, y1)
  if (tight) [x0, y0, x1, y1] = [x0 + tight.left, y0 + tight.top, x0 + tight.right, y0 + tight.bottom]
  const pad = step * 2
  // The margin ends halfway across a narrower gap to neighbouring ink, such as a caption
  // just below, so faint edges of that ink stay out after re-rendering at another DPI.
  const above = ink.boundingBox(x0, Math.max(0, y0 - 2 * pad), x1, y0)
  const below = ink.boundingBox(x0, y1, x1, Math.min(height, y1 + 2 * pad))
  const top = Math.max(0, y0 - pad, above ? y0 - Math.trunc((y0 - Math.max(0, y0 - 2 * pad) - above.bottom) / 2) : 0)
  const bottom = Math.min(height, y1 + pad, below ? y1 + Math.trunc(below.top / 2) : height)
  return [Math.max(0, x0 - pad), top, Math.min(width, x1 + pad), bottom]
}

/**
 * `_drop_text_bands`: move the top and bottom of an oversized model box past body text above and below the figure.
 *
 * The box splits into bands of rows between blank rows. A band is a text line when its ink
 * runs on across typed spaces to the sideways growth limit, as a line of a paragraph or a
 * caption does beside a narrower figure; bands from each edge inward go while they are text.
 * An edge that cuts a line is first moved out to the whole line, since a sliver of
 * descenders alone has gaps too wide to read as text.
 */
function dropTextBands(ink: InkMask, box: FigurePixelBox, limits: FigurePixelBox, reach: number): [number, number] {
  const [x0, y0, x1, y1] = box
  if (!(x0 < x1 && y0 < y1)) return [y0, y1]
  let top = y0
  let bottom = y1
  while (top > Math.max(0, limits[1]) && ink.boundingBox(x0, top - 1, x1, top) !== undefined) top -= 1
  while (bottom < Math.min(ink.height, limits[3]) && ink.boundingBox(x0, bottom, x1, bottom + 1) !== undefined) bottom += 1
  const bands: Array<{ top: number; bottom: number }> = []
  for (let y = top; y < bottom; y += 1) {
    if (ink.boundingBox(x0, y, x1, y + 1) === undefined) continue
    const last = bands.at(-1)
    if (last && last.bottom === y) last.bottom = y + 1
    else bands.push({ top: y, bottom: y + 1 })
  }
  const runsOn = (bandTop: number, bandBottom: number): boolean => {
    let left = x0
    let right = x1
    for (;;) {
      if (!(left > Math.max(0, limits[0]))) break
      const found = ink.boundingBox(Math.max(0, left - reach), bandTop, left, bandBottom)
      if (!found) break
      left = Math.max(0, left - reach) + found.left
    }
    for (;;) {
      if (!(right < Math.min(ink.width, limits[2]))) break
      const found = ink.boundingBox(right, bandTop, Math.min(ink.width, right + reach), bandBottom)
      if (!found) break
      right += found.right
    }
    return left <= Math.max(0, limits[0]) || right >= Math.min(ink.width, limits[2])
  }
  const kept = bands.map((_, index) => index).filter((index) => !runsOn(bands[index].top, bands[index].bottom))
  if (!kept.length) return [y0, y1]
  const first = kept[0]
  const last = kept[kept.length - 1]
  return [first > 0 ? bands[first].top : y0, last < bands.length - 1 ? bands[last].bottom : y1]
}

export function resolveFigureBoxes(image: RGBImage, boxes: FigureBoxes): Array<{ key: string; box: FigurePixelBox }> {
  const pixels = boxes.entries.map(({ key, box }) => {
    const values = [box.x0, box.y0, box.x1, box.y1].map((value, index) => PythonNumber.round(value * (index % 2 === 0 ? image.width : image.height) / 1000))
    return { key, box: values as FigurePixelBox }
  })
  const frames = matchFigureFrames(pixels, figureFrames(image), image.width, image.height)
  const resolved = pixels.map((item) => {
    const frame = frames.get(item.key)
    return { key: item.key, box: frame ? padFigureBox(frame, image.width, image.height) : snapUnframedBox(image, item.box) }
  })
  resolved.forEach((item, index) => {
    const a = item.box
    for (const other of resolved.slice(index + 1)) {
      const b = other.box
      const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
      if (overlap > Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) * 0.05) {
        throw new LatexError(`figure boxes ${item.key} and ${other.key} overlap; give each illustration one complete, separate whole-page box`)
      }
    }
  })
  return resolved
}

const figureCaption = new Pattern(String.raw`^\s*(?:figure|fig\.?|图)\s*\d`, { ignoreCase: true })

/** A recognized numbered caption beneath a closed frame requires a complete image crop. */
export function validateFigureRegions(markup: PageMarkup, image: RGBImage, lines: readonly OcrLine[]): void {
  const resolved = markup.figures.isEmpty ? [] : resolveFigureBoxes(image, markup.figures)
  for (const frame of figureFrames(image)) {
    const caption = lines.find((line) => line.confidence >= 50 && figureCaption.contains(line.text)
      && frame[0] <= (line.left + line.right) / 2 && (line.left + line.right) / 2 <= frame[2]
      && frame[3] <= line.top && line.top <= frame[3] + image.height * 0.035)
    if (!caption) continue
    const area = (frame[2] - frame[0]) * (frame[3] - frame[1])
    const retained = resolved.some(({ box }) => {
      const overlap = Math.max(0, Math.min(box[2], frame[2]) - Math.max(box[0], frame[0])) * Math.max(0, Math.min(box[3], frame[3]) - Math.max(box[1], frame[1]))
      return overlap >= area * 0.95
    })
    if (!retained) {
      throw new LatexError(`framed illustration ${PythonText.repr(caption.text)} must be retained as one complete \\rebuildfigure; `
        + 'replace its transcribed code/text with the crop, keeping only the external caption as text')
    }
  }
}

/** `prepare_figures`: crop each figure from the source PDF at 400 DPI and place it at its printed size. */
export async function prepareFigures(
  markup: PageMarkup, pageImage: RGBImage, sourcePage: PDFPage, layout: PageLayout, directory: string, dpi = 400
): Promise<Array<{ key: string; placement: FigurePlacement }>> {
  if (markup.figures.isEmpty) return []
  await mkdir(directory, { recursive: true })
  const rows = markup.body.split('\n')
  const contexts = lineContexts(rows)
  const frames = new Map<string, LineFrame[]>()
  rows.forEach((row, index) => {
    for (const key of MarkupPatterns.figureCall.findAll(row)) if (!frames.has(key)) frames.set(key, contexts[index].frames)
  })
  const scale = pageSize(sourcePage).width / pageImage.width
  const placements: Array<{ key: string; placement: FigurePlacement }> = []
  for (const { key, box } of resolveFigureBoxes(pageImage, markup.figures)) {
    const [x0, y0, x1, y1] = box
    const clip = { x: x0 * scale, y: y0 * scale, width: (x1 - x0) * scale, height: (y1 - y0) * scale }
    let crop: RGBImage
    try {
      crop = await renderPage(sourcePage, dpi, clip)
    } catch {
      throw new LatexError(`figure ${key} could not be cropped from the source page`)
    }
    const file = `fig-${key}.png`
    let data: Uint8Array
    try {
      data = crop.meanSaturation() < 25 ? await GrayImage.from(crop).cleanedForPrint().pngData() : await crop.pngData()
    } catch {
      throw new LatexError(`figure ${key} could not be saved`)
    }
    await atomicWriteFile(join(directory, file), data)
    const { origin, free } = figureOrigin(frames.get(key) ?? [], layout, clip.x, markup.columns)
    const offset = free ? clip.x - origin : Math.max(0, clip.x - origin)
    placements.push({ key, placement: { file, width: clip.width, offset, top: clip.y, height: clip.height, free } })
  }
  return placements
}

/**
 * `_figure_origin`: where a figure's offset counts from: the left edge of the column or block it
 * sits in, or the left edge of the text area for a figure outside all of them, which is free to
 * keep its printed place.
 */
export function figureOrigin(frames: readonly LineFrame[], layout: PageLayout, x0: number, columns: number): { origin: number; free: boolean } {
  let left = layout.left
  let width = layout.textWidth
  let free = true
  for (const frame of frames) {
    if (frame.name === 'sidebyside') {
      const widths = sideWidths(frame.argument ?? '', width, layout.columnGap, columns)
      left += widths.slice(0, frame.block).reduce((sum, value) => sum + value, 0) + frame.block * layout.columnGap
      width = widths[frame.block]
      free = false
    } else if (frame.name === 'multicols' || frame.name === 'rebuildflow') {
      const count = PythonText.strip(frame.argument ?? '') === '3' ? 3 : 2
      const column = (width - (count - 1) * layout.columnGap) / count
      const edges = Array.from({ length: count }, (_, index) => left + index * (column + layout.columnGap))
      const candidates = edges.filter((edge) => edge <= x0 + 2)
      left = candidates.length ? Math.max(...candidates) : left
      width = column
      free = false
    } else if (['indentblock', 'quote', 'quotation'].includes(frame.name)) {
      free = false
    }
  }
  return { origin: left, free }
}
