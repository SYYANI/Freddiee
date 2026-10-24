// Stage 3 layout write-back and fallback-line derivation, ported from Swift
// LayoutParser. The clustering mirrors the band and Manhattan-distance stages
// of upstream BabelDOC's extract_char.py.
import { boxCoordinates, pythonBool, type ILBox, type ILDocument, type ILPage, type ILPageLayout } from './il'
import type { LayoutDetection, PageLayoutResult } from './layoutDetector'

const f = Math.fround

export class BabelDocLayoutParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocLayoutParseError'
  }
}

export const LayoutParser = {
  /** Writes detector layouts into the canonical IL in document page order.
   * PageLayoutResult.sourcePageNumber is 1-based; IL page_number is 0-based. */
  writeLayouts(document: ILDocument, pageResults: PageLayoutResult[]): void {
    const resultsByPage = new Map(pageResults.map((result) => [result.sourcePageNumber - 1, result]))
    for (const page of document.page ?? []) {
      const pageNumber = page.page_number
      const result = pageNumber === undefined ? undefined : resultsByPage.get(pageNumber)
      if (!result) continue
      const mediaBox = result.pdfMediaBox
        ? { width: Math.abs(result.pdfMediaBox.x1 - result.pdfMediaBox.x0), height: Math.abs(result.pdfMediaBox.y1 - result.pdfMediaBox.y0) }
        : mediaBoxSizeFor(page)
      page.page_layout = makePageLayouts(result.detections, mediaBox.width, mediaBox.height)
    }
  },

  /** Appends fallback-line layouts derived from character visual boxes. */
  appendFallbackLines(page: ILPage): void {
    const characters = (page.pdf_character ?? [])
      .map((character): CharacterBox | null => {
        const box = boxCoordinates(character.visual_bbox?.box)
        if (!box) return null
        return {
          x: box.x, y: box.y, x2: box.x2, y2: box.y2,
          vertical: pythonBool(character.vertical)
        }
      })
      .filter((character): character is CharacterBox => character !== null)
    if (characters.length === 0) return

    const horizontal = cluster(characters.filter((character) => !character.vertical), 'horizontal')
    const vertical = cluster(characters.filter((character) => character.vertical), 'vertical')
    const ordered = [...horizontal, ...vertical]
      .map((line, offset) => ({ line, offset, position: linePosition(line) }))
      .sort((lhs, rhs) => {
        if (lhs.position.y !== rhs.position.y) return lhs.position.y - rhs.position.y
        if (lhs.position.x !== rhs.position.x) return lhs.position.x - rhs.position.x
        return lhs.offset - rhs.offset
      })
      .map((entry) => entry.line)
    const lines = mergeLines(ordered)

    page.page_layout ??= []
    for (const line of lines) {
      page.page_layout.push({
        box: lineBounds(line), id: page.page_layout.length + 1, conf: 1, class_name: 'fallback_line'
      })
    }
  }
}

/** Converts image-space detections with the project int/clip/expansion rules. */
export function makePageLayouts(detections: LayoutDetection[], mediaBoxWidth: number, mediaBoxHeight: number): ILPageLayout[] {
  const width = Math.ceil(mediaBoxWidth)
  const height = Math.ceil(mediaBoxHeight)
  if (width <= 0 || height <= 0) return []
  return detections.map((detection, index) => {
    const source = detection.imageBox
    const x0 = clip(Math.trunc(f(source.x0 - 1)), width - 1)
    const y0 = clip(Math.trunc(f(f(height) - source.y1 - 1)), height - 1)
    const x1 = clip(Math.trunc(f(source.x1 + 1)), width - 1)
    const y1 = clip(Math.trunc(f(f(height) - source.y0 + 1)), height - 1)
    return {
      box: { x: x0, y: y0, x2: x1, y2: y1 },
      id: index + 1,
      conf: detection.confidence,
      class_name: detection.className
    }
  })
}

interface CharacterBox {
  x: number; y: number; x2: number; y2: number
  vertical: boolean
}

interface CharacterLine {
  characters: CharacterBox[]
}

function lineBounds(line: CharacterLine): ILBox {
  return {
    x: Math.min(...line.characters.map((c) => c.x)),
    y: Math.min(...line.characters.map((c) => c.y)),
    x2: Math.max(...line.characters.map((c) => c.x2)),
    y2: Math.max(...line.characters.map((c) => c.y2))
  }
}

function linePosition(line: CharacterLine): { y: number; x: number } {
  const count = line.characters.length
  let sumY = 0
  let sumX = 0
  for (const character of line.characters) {
    sumY += (character.y + character.y2) / 2
    sumX += (character.x + character.x2) / 2
  }
  return { y: -sumY / count, x: sumX / count }
}

function clip(value: number, upperBound: number): number {
  return Math.min(Math.max(value, 0), upperBound)
}

function mediaBoxSizeFor(page: ILPage): { width: number; height: number } {
  const box = boxCoordinates(page.mediabox?.box)
  if (!box) throw new BabelDocLayoutParseError('Stage 3 layout write-back requires a complete page mediabox.')
  return { width: Math.abs(box.x2 - box.x), height: Math.abs(box.y2 - box.y) }
}

type Orientation = 'horizontal' | 'vertical'

function cluster(input: CharacterBox[], orientation: Orientation): CharacterLine[] {
  if (input.length === 0) return []
  const secondaryStart = (c: CharacterBox) => (orientation === 'horizontal' ? c.y : c.x)
  const secondaryEnd = (c: CharacterBox) => (orientation === 'horizontal' ? c.y2 : c.x2)
  const mainSize = (c: CharacterBox) => (orientation === 'horizontal' ? c.x2 - c.x : c.y2 - c.y)
  const mainStart = (c: CharacterBox) => (orientation === 'horizontal' ? c.x : c.y)

  const bands: { characters: CharacterBox[]; start: number; end: number }[] = []
  const sorted = [...input].sort((lhs, rhs) => secondaryStart(lhs) - secondaryStart(rhs))
  for (const character of sorted) {
    const start = secondaryStart(character)
    const end = secondaryEnd(character)
    const size = end - start
    let best = -1
    let bestRatio = 0.5
    for (let index = bands.length - 1; index >= 0; index -= 1) {
      if (bands[index].end < start) break
      const overlap = Math.max(0, Math.min(end, bands[index].end) - Math.max(start, bands[index].start))
      const ratio = size > 0 ? overlap / size : 0
      if (ratio > bestRatio) { best = index; bestRatio = ratio }
    }
    if (best >= 0) {
      const band = bands.splice(best, 1)[0]
      band.characters.push(character)
      band.start = Math.min(band.start, start)
      band.end = Math.max(band.end, end)
      bands.push(band)
    } else {
      bands.push({ characters: [character], start, end })
    }
  }

  const result: CharacterLine[] = []
  for (const band of bands) {
    const sizes = band.characters.map(mainSize).filter((size) => size > 0)
    const average = sizes.length === 0 ? 10 : sizes.reduce((sum, size) => sum + size, 0) / sizes.length
    const epsilon = average * 3.5
    const visited = new Set<number>()
    for (let seed = 0; seed < band.characters.length; seed += 1) {
      if (visited.has(seed)) continue
      const queue = [seed]
      const component: CharacterBox[] = []
      visited.add(seed)
      while (queue.length > 0) {
        const current = queue.pop() as number
        const value = band.characters[current]
        component.push(value)
        for (let candidate = 0; candidate < band.characters.length; candidate += 1) {
          if (visited.has(candidate)) continue
          const other = band.characters[candidate]
          const distance = Math.abs((value.x + value.x2) / 2 - (other.x + other.x2) / 2)
            + Math.abs((value.y + value.y2) / 2 - (other.y + other.y2) / 2)
          if (distance <= epsilon) { visited.add(candidate); queue.push(candidate) }
        }
      }
      component.sort((lhs, rhs) => mainStart(lhs) - mainStart(rhs))
      const secondarySizes = component.map((c) => secondaryEnd(c) - secondaryStart(c)).filter((size) => size > 0)
      const lineExtent = Math.max(...component.map(secondaryEnd)) - Math.min(...component.map(secondaryStart))
      const maximumSize = secondarySizes.length > 0 ? Math.max(...secondarySizes) : 0
      if (lineExtent > maximumSize * 1.5 && component.length > 1 && maximumSize > 0) {
        const centers = component.map((c) => (secondaryStart(c) + secondaryEnd(c)) / 2)
        for (const indices of connectedComponents1D(centers, maximumSize * 0.5)) {
          const split = indices.map((index) => component[index]).sort((lhs, rhs) => mainStart(lhs) - mainStart(rhs))
          result.push({ characters: split })
        }
      } else {
        result.push({ characters: component })
      }
    }
  }
  return result
}

function connectedComponents1D(values: number[], epsilon: number): number[][] {
  const visited = new Set<number>()
  const result: number[][] = []
  for (let seed = 0; seed < values.length; seed += 1) {
    if (visited.has(seed)) continue
    const queue = [seed]
    const component: number[] = []
    visited.add(seed)
    while (queue.length > 0) {
      const current = queue.pop() as number
      component.push(current)
      for (let candidate = 0; candidate < values.length; candidate += 1) {
        if (visited.has(candidate)) continue
        if (Math.abs(values[current] - values[candidate]) <= epsilon) {
          visited.add(candidate)
          queue.push(candidate)
        }
      }
    }
    result.push(component)
  }
  return result
}

function mergeLines(input: CharacterLine[]): CharacterLine[] {
  if (input.length === 0) return []
  const lines = input.map((line) => ({ characters: [...line.characters] }))
  const merged: CharacterLine[] = []
  const skipped = new Set<number>()

  for (let index = 0; index < lines.length; index += 1) {
    if (skipped.has(index)) continue
    let line = lines[index]
    if (line.characters.length === 0) { merged.push(line); continue }
    let box = boundsTuple(line)
    const heights = line.characters.map((c) => c.y2 - c.y).filter((height) => height > 0)
    const averageHeight = heights.length === 0 ? 0 : heights.reduce((sum, height) => sum + height, 0) / heights.length
    const maximumVerticalGap = averageHeight * 1.5
    let didMerge = false

    for (let candidateIndex = index + 1; candidateIndex < lines.length; candidateIndex += 1) {
      if (skipped.has(candidateIndex)) continue
      const candidate = lines[candidateIndex]
      if (candidate.characters.length === 0) continue
      const candidateBox = boundsTuple(candidate)
      if (box.y - candidateBox.y2 > maximumVerticalGap) break

      const intersection = Math.max(0, Math.min(box.x2, candidateBox.x2) - Math.max(box.x, candidateBox.x))
        * Math.max(0, Math.min(box.y2, candidateBox.y2) - Math.max(box.y, candidateBox.y))
      const area = Math.max(0, box.x2 - box.x) * Math.max(0, box.y2 - box.y)
      const candidateArea = Math.max(0, candidateBox.x2 - candidateBox.x) * Math.max(0, candidateBox.y2 - candidateBox.y)

      if (candidateArea > 0 && area >= candidateArea && intersection / candidateArea > 0.6) {
        line.characters.push(...candidate.characters)
      } else if (area > 0 && candidateArea > area && intersection / area > 0.6) {
        candidate.characters.push(...line.characters)
        line = candidate
        lines[candidateIndex] = candidate
      } else if (shouldMergeAdjacent(line, candidate, box, candidateBox)) {
        line.characters.push(...candidate.characters)
      } else {
        continue
      }
      skipped.add(candidateIndex)
      didMerge = true
      box = union(box, candidateBox)
    }

    if (didMerge) {
      if (line.characters[0]?.vertical === true) {
        line.characters.sort((lhs, rhs) => lhs.y - rhs.y)
      } else {
        line.characters.sort((lhs, rhs) => lhs.x - rhs.x)
      }
    }
    merged.push(line)
  }
  return merged
}

function shouldMergeAdjacent(
  firstLine: CharacterLine,
  secondLine: CharacterLine,
  first: Bounds,
  second: Bounds
): boolean {
  if (firstLine.characters[0]?.vertical !== true) {
    const firstHeight = first.y2 - first.y
    const secondHeight = second.y2 - second.y
    if (firstHeight <= 0 || secondHeight <= 0) return false
    const overlap = Math.max(0, Math.min(first.y2, second.y2) - Math.max(first.y, second.y))
    if (overlap / firstHeight <= 0.7 || overlap / secondHeight <= 0.7) return false
    const gap = Math.max(first.x, second.x) - Math.min(first.x2, second.x2)
    const widths = [...firstLine.characters, ...secondLine.characters].map((c) => c.x2 - c.x).filter((width) => width > 0)
    const average = widths.length === 0 ? 0 : widths.reduce((sum, width) => sum + width, 0) / widths.length
    return gap >= 0 && average > 0 && gap < average * 1.5
  }
  const firstWidth = first.x2 - first.x
  const secondWidth = second.x2 - second.x
  if (firstWidth <= 0 || secondWidth <= 0) return false
  const overlap = Math.max(0, Math.min(first.x2, second.x2) - Math.max(first.x, second.x))
  if (overlap / firstWidth <= 0.7 || overlap / secondWidth <= 0.7) return false
  const gap = Math.max(first.y, second.y) - Math.min(first.y2, second.y2)
  const heights = [...firstLine.characters, ...secondLine.characters].map((c) => c.y2 - c.y).filter((height) => height > 0)
  const average = heights.length === 0 ? 0 : heights.reduce((sum, height) => sum + height, 0) / heights.length
  return gap >= 0 && average > 0 && gap < average * 1.5
}

type Bounds = { x: number; y: number; x2: number; y2: number }

function boundsTuple(line: CharacterLine): Bounds {
  return {
    x: Math.min(...line.characters.map((c) => c.x)),
    y: Math.min(...line.characters.map((c) => c.y)),
    x2: Math.max(...line.characters.map((c) => c.x2)),
    y2: Math.max(...line.characters.map((c) => c.y2))
  }
}

function union(lhs: Bounds, rhs: Bounds): Bounds {
  return { x: Math.min(lhs.x, rhs.x), y: Math.min(lhs.y, rhs.y), x2: Math.max(lhs.x2, rhs.x2), y2: Math.max(lhs.y2, rhs.y2) }
}
