// Shared placeholder invariants used by the translation stage and the
// continuation merge/split. The real translator lives in translator.ts.
import type { ILPdfParagraphComposition, ILPdfStyle } from './il'

export interface FormulaPlaceholder {
  id: number
  token: string
  composition: ILPdfParagraphComposition
}

export interface TranslateInput {
  text: string
  placeholders: FormulaPlaceholder[]
  baseStyle?: ILPdfStyle | null
}

export interface ILFormulaPlaceholderProviding {
  formulaPlaceholder(id: number): string
}

export const defaultFormulaPlaceholderProvider: ILFormulaPlaceholderProviding = {
  formulaPlaceholder(id: number): string {
    return `<b${id}>`
  }
}

/** Each placeholder token occurs exactly once in the output. */
export function hasExactlyOneOfEachPlaceholder(output: string, input: TranslateInput): boolean {
  return input.placeholders.every((placeholder) => {
    let count = 0
    let searchStart = output.indexOf(placeholder.token)
    while (searchStart !== -1) {
      count += 1
      if (count > 1) return false
      searchStart = output.indexOf(placeholder.token, searchStart + 1)
    }
    return count === 1
  })
}
