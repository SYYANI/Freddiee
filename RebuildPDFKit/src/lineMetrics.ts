import metricsBase64 from '../resources/line-metrics.bin.b64?raw'
import { Pattern } from './pattern'

/** Run-length advance table of one font, in em. */
class AdvanceTable {
  constructor(private readonly starts: Uint32Array, private readonly widths: Float64Array) {}

  /** `Font.text_length(text, fontsize=1)`: advances summed per code point. */
  length(text: string): number {
    let total = 0
    for (const scalar of text) total += this.advance(scalar.codePointAt(0)!)
    return total
  }

  private advance(code: number): number {
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2)
      if (this.starts[middle] <= code) low = middle
      else high = middle - 1
    }
    return this.widths[low]
  }
}

let tables: AdvanceTable[] | undefined

function load(): AdvanceTable[] {
  const bytes = Buffer.from(metricsBase64.trim(), 'base64')
  if (bytes.subarray(0, 5).toString('latin1') !== 'RPLM1') throw new Error('Missing or invalid RebuildPDFKit line-metrics.bin')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 5
  const readUInt32 = (): number => {
    const value = view.getUint32(offset, true)
    offset += 4
    return value
  }
  const result: AdvanceTable[] = []
  for (let font = 0; font < 3; font += 1) {
    const valueCount = readUInt32()
    const values = new Float64Array(valueCount)
    for (let index = 0; index < valueCount; index += 1) {
      values[index] = view.getFloat32(offset, true)
      offset += 4
    }
    const runCount = readUInt32()
    const starts = new Uint32Array(runCount)
    const widths = new Float64Array(runCount)
    for (let index = 0; index < runCount; index += 1) {
      starts[index] = readUInt32()
      widths[index] = values[view.getUint16(offset, true)]
      offset += 2
    }
    result.push(new AdvanceTable(starts, widths))
  }
  return result
}

const styles = new Pattern(
  String.raw`\\(textit|textbf|textsc|underline|texttt|mathrm|mathbf|mathit|text|`
    + String.raw`overline|bar|unclear|emph|hat|tilde)\b\s*`
)
const dots = new Pattern(String.raw`\\(cdots|ldots|dots)\b`)
const breaks = new Pattern(String.raw`\\(linebreak|noindent|hfill)\b`)
const commands = new Pattern(String.raw`\\[A-Za-z]+\s*`)
const escaped = new Pattern(String.raw`\\(.)`)
const syntax = new Pattern(String.raw`[{}$^_]`)

/**
 * `LineMetrics`: estimate how much of the measure a source line fills in the chosen face.
 *
 * The advances are PyMuPDF's base fonts (Times, Helvetica, Courier) with MuPDF's
 * fallback fonts, exported by rebuild-pdf's tools/export_line_metrics.py, so the size
 * estimate matches the Python package exactly.
 */
export class LineMetrics {
  private readonly table: AdvanceTable

  constructor(font: string) {
    tables ??= load()
    this.table = tables[({ serif: 0, sans: 1, typewriter: 2 } as Record<string, number>)[font] ?? 0]
  }

  widthEm(line: string): number {
    let text = line.replaceAll('\\-', '-')
    text = styles.sub(text, '')
    text = dots.sub(text, '...')
    text = breaks.sub(text, '')
    text = commands.sub(text, 'o')
    text = escaped.sub(text, (match) => match.at(1))
    text = syntax.sub(text, '').replaceAll('~', ' ')
    return this.table.length(text)
  }
}
