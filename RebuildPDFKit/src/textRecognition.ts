import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { RGBImage } from './bitmap'
import type { OcrLine } from './geometry'
import { PythonNumber, PythonText } from './pattern'

/**
 * Finds the printed lines of a page image: their boxes measure the text area, and their
 * (noisy) text helps the model notice every line.
 */
export interface TextRecognizing {
  recognizeLines(image: RGBImage): Promise<OcrLine[]>
  /** Releases the engine; the recognizer may not be used afterwards. */
  close?(): Promise<void>
}

const moduleRequire = createRequire(import.meta.url)

/** A file of a dependency, outside the asar archive in a packaged app (worker threads cannot read inside it). */
function unpacked(path: string): string {
  return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

interface TesseractWord {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

interface TesseractWorker {
  setParameters(parameters: Record<string, string>): Promise<unknown>
  recognize(image: Buffer, options: Record<string, never>, output: { blocks: boolean; text: boolean }): Promise<{
    data: { blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: TesseractWord[] }> }> }> | null }
  }>
  terminate(): Promise<unknown>
}

/**
 * Tesseract text recognition, as the Python package runs it (`tesseract --psm 3 tsv`): the
 * bundled English LSTM model through tesseract.js, so it runs the same on every platform
 * and offline. Each Tesseract line becomes one `OcrLine`, split where a gap is far wider
 * than any word space.
 */
export class TesseractTextRecognizer implements TextRecognizing {
  private worker?: Promise<TesseractWorker>

  constructor(readonly options: { language?: string; dpi?: number } = {}) {}

  private start(): Promise<TesseractWorker> {
    this.worker ??= (async () => {
      const tesseract = moduleRequire('tesseract.js') as {
        createWorker(langs: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>
        OEM: { LSTM_ONLY: number }
      }
      const workerPath = unpacked(join(dirname(moduleRequire.resolve('tesseract.js/package.json')), 'src', 'worker-script', 'node', 'index.js'))
      const langPath = unpacked(join(dirname(moduleRequire.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'))
      const worker = await tesseract.createWorker(this.options.language ?? 'eng', tesseract.OEM.LSTM_ONLY, {
        workerPath, langPath, gzip: true, cacheMethod: 'none', logger: () => undefined, errorHandler: () => undefined
      })
      await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: String(this.options.dpi ?? 240) })
      return worker
    })()
    return this.worker
  }

  async recognizeLines(image: RGBImage): Promise<OcrLine[]> {
    const worker = await this.start()
    const png = Buffer.from(await image.pngData())
    const { data } = await worker.recognize(png, {}, { blocks: true, text: false })
    const groups: TesseractWord[][] = []
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          const words = line.words.filter((word) => PythonText.strip(word.text))
          if (words.length) groups.push(words)
        }
      }
    }
    return tesseractLines(groups)
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker) await (await worker).terminate()
  }
}

/** `tesseract_lines`: one line per Tesseract line part, with its mean word confidence. */
export function tesseractLines(groups: ReadonlyArray<readonly TesseractWord[]>): OcrLine[] {
  const lines: OcrLine[] = []
  for (const words of groups.flatMap(splitAtGaps)) {
    const confidences = words.map((word) => word.confidence).filter((value) => value >= 0)
    const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0
    lines.push({
      id: `l${String(lines.length + 1).padStart(4, '0')}`,
      left: Math.min(...words.map((word) => word.bbox.x0)),
      top: Math.min(...words.map((word) => word.bbox.y0)),
      right: Math.max(...words.map((word) => word.bbox.x1)),
      bottom: Math.max(...words.map((word) => word.bbox.y1)),
      text: PythonText.strip(words.map((word) => PythonText.strip(word.text)).join(' ')),
      confidence: PythonNumber.round(confidence, 1)
    })
  }
  return lines
}

/**
 * `_split_at_gaps`: split a Tesseract line where a gap is far wider than any word space.
 *
 * Tesseract sometimes joins a text line with a formula across the column gap, or a
 * row of separate figure labels; such a line would pass for one very wide text line.
 */
function splitAtGaps(line: readonly TesseractWord[]): TesseractWord[][] {
  const words = [...line].sort((a, b) => a.bbox.x0 - b.bbox.x0)
  const heights = words.map((word) => word.bbox.y1 - word.bbox.y0).sort((a, b) => a - b)
  const limit = 2.5 * heights[Math.trunc(heights.length / 2)]
  const parts: TesseractWord[][] = [[words[0]]]
  for (const word of words.slice(1)) {
    const previous = parts[parts.length - 1].at(-1)!
    if (word.bbox.x0 - previous.bbox.x1 > limit) parts.push([])
    parts[parts.length - 1].push(word)
  }
  return parts
}
