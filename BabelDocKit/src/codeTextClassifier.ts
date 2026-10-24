// Pseudocode recognition, ported from Swift CodeTextClassifier. A font counts
// as code when monospace (or its name says so) and its characters sit on a
// light neutral fill background.
import { boxCoordinates, pythonBool, type ILBox, type ILPdfFont, type ILPage, type ILPdfStyle, type PythonBool } from './il'

const codeNameFragments = [
  'courier', 'mono', 'menlo', 'consolas', 'inconsolata',
  'sourcecode', 'source code', 'jetbrains', 'codefont'
]

function isLightNeutral(instruction: string | undefined): boolean {
  if (!instruction) return false
  const tokens = instruction.split(/\s+/).filter((token) => token.length > 0)
  const numbers: number[] = []
  let color: [number, number, number] | null = null
  for (const token of tokens) {
    const number = Number(token)
    if (!Number.isNaN(number) && token.trim().length > 0) {
      numbers.push(number)
      continue
    }
    switch (token) {
      case 'rg':
        if (numbers.length >= 3) {
          color = [numbers[numbers.length - 3], numbers[numbers.length - 2], numbers[numbers.length - 1]]
        }
        break
      case 'g':
        if (numbers.length > 0) {
          const value = numbers[numbers.length - 1]
          color = [value, value, value]
        }
        break
      case 'sc':
      case 'scn':
        if (numbers.length >= 3) {
          color = [numbers[numbers.length - 3], numbers[numbers.length - 2], numbers[numbers.length - 1]]
        } else if (numbers.length > 0) {
          const value = numbers[numbers.length - 1]
          color = [value, value, value]
        }
        break
      default:
        break
    }
    numbers.length = 0
  }
  if (!color) return false
  const average = (color[0] + color[1] + color[2]) / 3
  const spread = Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2])
  return average >= 0.82 && average <= 0.99 && spread <= 0.12
}

function intersects(lhs: ILBox | undefined, rhs: ILBox | undefined): boolean {
  const left = boxCoordinates(lhs)
  const right = boxCoordinates(rhs)
  if (!left || !right) return false
  return Math.min(left.x2, right.x2) > Math.max(left.x, right.x) && Math.min(left.y2, right.y2) > Math.max(left.y, right.y)
}

export const CodeTextClassifier = {
  truthy(value: PythonBool | undefined): boolean {
    return pythonBool(value)
  },

  /** Parses a passthrough graphics instruction stream for the last fill color
   * and reports whether it is the light neutral shade code backgrounds use. */
  isLightNeutral(instruction: string | undefined): boolean {
    return isLightNeutral(instruction)
  },

  isCodeFont(font: ILPdfFont): boolean {
    if (pythonBool(font.monospace)) return true
    const name = ((font.name ?? '').split('+').pop() ?? '').toLowerCase()
    return codeNameFragments.some((fragment) => name.includes(fragment))
  },

  isCodeStyle(style: ILPdfStyle | undefined, fontIDs: Set<string>): boolean {
    const fontID = style?.font_id
    return fontID !== undefined && fontIDs.has(fontID)
  },

  fontIDs(page: ILPage): Set<string> {
    const candidates = new Set<string>()
    for (const font of page.pdf_font ?? []) {
      if (font.font_id !== undefined && CodeTextClassifier.isCodeFont(font)) candidates.add(font.font_id)
    }
    if (candidates.size === 0) return candidates
    const backgrounds: ILBox[] = []
    for (const curve of page.pdf_curve ?? []) {
      if (pythonBool(curve.fill_background) && isLightNeutral(curve.graphic_state?.passthrough_per_char_instruction)) {
        const box = curve.box
        if (box) backgrounds.push(box)
      }
    }
    if (backgrounds.length === 0) return new Set()

    const matched = new Set<string>()
    for (const paragraph of page.pdf_paragraph ?? []) {
      for (const composition of paragraph.pdf_paragraph_composition ?? []) {
        const sameStyle = composition.pdf_same_style_characters
        const fontID = sameStyle?.pdf_style?.font_id
        if (!sameStyle || fontID === undefined || !candidates.has(fontID)) continue
        const onBackground = (sameStyle.pdf_character ?? []).some((character) =>
          backgrounds.some((background) => intersects(character.visual_bbox?.box ?? character.box, background)))
        if (onBackground) matched.add(fontID)
      }
    }
    return matched
  }
}
