// Translation/LaTeXCommandArgumentModel.swift and LaTeXSignedIntegerAssignment.swift
import { isASCIIDigit, isWhitespace, type Characters } from './text'

export type LaTeXCommandArgumentRole = 'translatableText' | 'structural' | 'verbatim'
export type LaTeXCommandArgumentSyntax = 'requiredGroup' | 'optionalGroup' | 'delimited' | 'requiredGroupOrDelimited' | 'signedIntegerAssignment'

export interface LaTeXCommandArgumentRule {
  syntax: LaTeXCommandArgumentSyntax
  role: LaTeXCommandArgumentRole
}

const rule = (syntax: LaTeXCommandArgumentSyntax, role: LaTeXCommandArgumentRole): LaTeXCommandArgumentRule => ({ syntax, role })
const text = rule('requiredGroup', 'translatableText')
const structural = rule('requiredGroup', 'structural')
const verbatim = rule('requiredGroup', 'verbatim')
const optionalText = rule('optionalGroup', 'translatableText')
const optionalStructural = rule('optionalGroup', 'structural')
const delimitedVerbatim = rule('delimited', 'verbatim')
const groupedOrDelimitedVerbatim = rule('requiredGroupOrDelimited', 'verbatim')
const signedIntegerAssignment = rule('signedIntegerAssignment', 'structural')

export type LaTeXUnmodeledArgumentPolicy = 'parseAsText' | 'preserveAdjacentGroups'

export interface LaTeXCommandArgumentModel {
  arguments: LaTeXCommandArgumentRule[]
  unmodeledArguments: LaTeXUnmodeledArgumentPolicy
}

const model = (rules: LaTeXCommandArgumentRule[], unmodeledArguments: LaTeXUnmodeledArgumentPolicy = 'parseAsText'): LaTeXCommandArgumentModel => ({ arguments: rules, unmodeledArguments })
const noArguments = model([])
const conservative = model([], 'preserveAdjacentGroups')

const models = new Map<string, LaTeXCommandArgumentModel>()
const define = (names: string[], value: LaTeXCommandArgumentModel): void => {
  for (const name of names) models.set(name, value)
}
define(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'], model([optionalText, text]))
define(['caption', 'subcaption'], model([optionalText, text]))
define(['captionof'], model([structural, optionalText, text]))
define(['title', 'subtitle', 'keywords', 'abstract', 'icmltitle', 'icmltitlerunning'], model([text]))
define([
  'emph', 'underline', 'uline', 'uwave', 'sout', 'xout',
  'textbf', 'textit', 'textmd', 'textnormal', 'textrm', 'textsc', 'textsf', 'textsl', 'textup',
  'mbox', 'phantom', 'hphantom', 'vphantom', 'thanks'
], model([text]))
define(['smash'], model([optionalStructural, text]))
define(['texorpdfstring'], model([text, text]))
define(['footnote', 'footnotetext'], model([optionalStructural, text]))
define(['marginpar'], model([optionalText, text]))
define(['item'], model([optionalStructural]))
define(['makebox', 'framebox'], model([optionalStructural, optionalStructural, text]))
define(['parbox'], model([optionalStructural, optionalStructural, optionalStructural, structural, text]))
define(['raisebox'], model([structural, optionalStructural, optionalStructural, text]))
define(['rotatebox'], model([optionalStructural, structural, text]))
define(['scalebox'], model([structural, optionalStructural, text]))
define(['resizebox'], model([structural, structural, text]))
define(['shortstack', 'makecell'], model([optionalStructural, text]))
define(['multicolumn'], model([structural, structural, text]))
define(['multirow'], model([optionalStructural, structural, optionalStructural, structural, optionalStructural, text]))
define(['colorbox'], model([optionalStructural, structural, text]))
define(['fcolorbox'], model([optionalStructural, structural, structural, text]))
define(['textcolor'], model([optionalStructural, structural, text]))
define(['foreignlanguage'], model([optionalStructural, structural, text]))
define(['href'], model([optionalStructural, structural, text]))
define(['hyperref'], model([optionalStructural, text]))
define(['url', 'path', 'nolinkurl', 'texttt'], model([verbatim]))
define(['lstinline'], model([optionalStructural, delimitedVerbatim]))
define(['mintinline'], model([optionalStructural, structural, groupedOrDelimitedVerbatim]))
define(['author', 'date'], conservative)
define(['looseness'], model([signedIntegerAssignment]))
define([
  'addbibresource', 'addtolength', 'bibliography', 'bibliographystyle',
  'Cref', 'autoref', 'color', 'cref', 'definecolor', 'documentclass', 'eqref', 'include',
  'includegraphics', 'input', 'label', 'lstinputlisting', 'nocite', 'pageref',
  'pagestyle', 'ref', 'rule', 'setlength', 'thispagestyle', 'usepackage', 'vspace', 'hspace',
  'ensuremath', 'fancypagestyle', 'inputminted'
], conservative)
define([
  'noindent', 'indent', 'newline', 'newpage', 'clearpage', 'linebreak', 'pagebreak',
  'centering', 'raggedleft', 'raggedright', 'small', 'footnotesize', 'scriptsize', 'tiny',
  'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize', 'selectfont', 'tableofcontents',
  'textsection', 'LaTeX', 'TeX', 'verb'
], noArguments)

function environmentModel(name: string | undefined): LaTeXCommandArgumentModel {
  if (name === undefined) return conservative
  switch (name) {
    case 'description': case 'enumerate': case 'itemize': case 'list': case 'minipage': case 'spacing':
      return conservative
    case 'theorem': case 'lemma': case 'proposition': case 'corollary': case 'definition': case 'remark': case 'example': case 'proof':
      return model([optionalText])
    case 'abstract': case 'quote': case 'quotation': case 'verse':
      return noArguments
    default:
      return conservative
  }
}

/** The ordered argument signature of a command; unknown commands keep their adjacent groups. */
export function commandArgumentModel(name: string, environmentName?: string): LaTeXCommandArgumentModel {
  if (name === 'begin') return environmentModel(environmentName)
  if (name === 'end') return noArguments
  if (name.toLowerCase().startsWith('cite')) return conservative
  return models.get(name) ?? conservative
}

export interface LaTeXSignedIntegerAssignment {
  start: number
  end: number
  normalizedValue: string
}

/** An optional `=`, an optional sign and ASCII digits, each optionally preceded by whitespace. */
export function parseSignedIntegerAssignment(chars: Characters, start: number, limit: number): LaTeXSignedIntegerAssignment | undefined {
  if (start > limit) return undefined
  const whitespaceEnd = (from: number): number => {
    let cursor = from
    while (cursor < limit && isWhitespace(chars[cursor])) cursor += 1
    return cursor
  }
  let cursor = whitespaceEnd(start)
  let normalizedValue = ''
  if (cursor < limit && chars[cursor] === '=') {
    normalizedValue += '='
    cursor = whitespaceEnd(cursor + 1)
  }
  if (cursor < limit && (chars[cursor] === '+' || chars[cursor] === '-')) {
    normalizedValue += chars[cursor]
    cursor = whitespaceEnd(cursor + 1)
  }
  const digitsStart = cursor
  while (cursor < limit && isASCIIDigit(chars[cursor])) {
    normalizedValue += chars[cursor]
    cursor += 1
  }
  if (cursor <= digitsStart) return undefined
  return { start, end: cursor, normalizedValue }
}
