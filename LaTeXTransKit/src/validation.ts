// Validation/LaTeXStructuralTokenizer.swift and StructuralLaTeXValidator.swift
import { commandArgumentModel, parseSignedIntegerAssignment } from './commandArguments'
import { validationIssue, type LaTeXTranslationValidating, type LaTeXUnit, type TranslatedLaTeXUnit, type ValidationIssue } from './models'
import { characters, isASCIILetter, isNewline, isWhitespace, slice, sortedStrings, type Characters } from './text'

export type LaTeXStructuralToken =
  | { kind: 'command'; value: string }
  | { kind: 'beginEnvironment'; value: string }
  | { kind: 'endEnvironment'; value: string }
  | { kind: 'placeholder'; value: string }
  | { kind: 'numericAssignment'; command: string; value: string }
  | { kind: 'mathDelimiter'; value: string }
  | { kind: 'openingDelimiter'; value: string }
  | { kind: 'closingDelimiter'; value: string }

/** A `<PLACEHOLDER_...>` token on one line at `start`. */
export function placeholderAt(chars: Characters, start: number): { value: string; end: number } | undefined {
  let cursor = start + 1
  while (cursor < chars.length && chars[cursor] !== '>' && !isNewline(chars[cursor])) cursor += 1
  if (cursor >= chars.length || chars[cursor] !== '>') return undefined
  const value = slice(chars, start, cursor + 1)
  if (!value.startsWith('<PLACEHOLDER_')) return undefined
  return { value, end: cursor + 1 }
}

function commandName(chars: Characters, slash: number): { name: string; end: number } | undefined {
  let cursor = slash + 1
  const start = cursor
  while (cursor < chars.length && isASCIILetter(chars[cursor])) cursor += 1
  if (cursor <= start) return undefined
  let name = slice(chars, start, cursor)
  if (cursor < chars.length && chars[cursor] === '*') {
    name += '*'
    cursor += 1
  }
  return { name, end: cursor }
}

function environmentName(chars: Characters, commandEnd: number): { name: string; end: number } | undefined {
  let cursor = commandEnd
  while (cursor < chars.length && isWhitespace(chars[cursor])) cursor += 1
  if (cursor >= chars.length || chars[cursor] !== '{') return undefined
  const start = cursor + 1
  cursor = start
  while (cursor < chars.length && chars[cursor] !== '}') cursor += 1
  if (cursor >= chars.length || cursor <= start) return undefined
  return { name: slice(chars, start, cursor), end: cursor + 1 }
}

export function tokenize(text: string): LaTeXStructuralToken[] {
  const chars = characters(text)
  const tokens: LaTeXStructuralToken[] = []
  let index = 0
  while (index < chars.length) {
    const character = chars[index]
    if (character === '%') {
      while (index < chars.length && !isNewline(chars[index])) index += 1
      continue
    }
    if (character === '<') {
      const placeholder = placeholderAt(chars, index)
      if (placeholder) {
        tokens.push({ kind: 'placeholder', value: placeholder.value })
        index = placeholder.end
        continue
      }
    }
    if (character === '\\') {
      if (index + 1 < chars.length && ['(', ')', '[', ']'].includes(chars[index + 1])) {
        tokens.push({ kind: 'mathDelimiter', value: `\\${chars[index + 1]}` })
        index += 2
        continue
      }
      const command = commandName(chars, index)
      if (!command) {
        index = Math.min(index + 2, chars.length)
        continue
      }
      const normalizedName = command.name.replaceAll('*', '')
      if (normalizedName === 'begin' || normalizedName === 'end') {
        const environment = environmentName(chars, command.end)
        if (environment) {
          tokens.push({ kind: normalizedName === 'begin' ? 'beginEnvironment' : 'endEnvironment', value: environment.name })
          index = environment.end
          continue
        }
      }
      if (normalizedName !== 'eg' && normalizedName !== 'ie') tokens.push({ kind: 'command', value: `\\${command.name}` })
      index = command.end
      if (commandArgumentModel(normalizedName).arguments.some((argument) => argument.syntax === 'signedIntegerAssignment')) {
        const assignment = parseSignedIntegerAssignment(chars, index, chars.length)
        if (assignment) {
          tokens.push({ kind: 'numericAssignment', command: `\\${normalizedName}`, value: assignment.normalizedValue })
          index = assignment.end
        }
      }
      if (normalizedName === 'verb' && index < chars.length) {
        const delimiter = chars[index]
        index += 1
        while (index < chars.length && chars[index] !== delimiter) index += 1
        if (index < chars.length) index += 1
      }
      continue
    }
    if (character === '$') {
      tokens.push({ kind: 'mathDelimiter', value: '$' })
      index += 1
      continue
    }
    if (character === '{' || character === '[' || character === '(') tokens.push({ kind: 'openingDelimiter', value: character })
    else if (character === '}' || character === ']' || character === ')') tokens.push({ kind: 'closingDelimiter', value: character })
    index += 1
  }
  return tokens
}

const commandValue = (token: LaTeXStructuralToken): string | undefined => {
  switch (token.kind) {
    case 'command': return token.value
    case 'beginEnvironment': return `\\begin{${token.value}}`
    case 'endEnvironment': return `\\end{${token.value}}`
    default: return undefined
  }
}
const placeholderValue = (token: LaTeXStructuralToken): string | undefined => (token.kind === 'placeholder' ? token.value : undefined)
const mathDelimiterValue = (token: LaTeXStructuralToken): string | undefined => (token.kind === 'mathDelimiter' ? token.value : undefined)
const numericAssignmentValue = (token: LaTeXStructuralToken): string | undefined => (token.kind === 'numericAssignment' ? token.command + token.value : undefined)

function values(tokens: LaTeXStructuralToken[], value: (token: LaTeXStructuralToken) => string | undefined): string[] {
  return tokens.map(value).filter((item): item is string => item !== undefined)
}

function tokenCounts(items: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([key, count]) => b.get(key) === count)
}

function positiveDifferences(minuend: Map<string, number>, subtrahend: Map<string, number>): Map<string, number> {
  const result = new Map<string, number>()
  for (const [key, count] of minuend) {
    const difference = count - (subtrahend.get(key) ?? 0)
    if (difference > 0) result.set(key, difference)
  }
  return result
}

function formattedCounts(counts: Map<string, number>): string {
  return sortedStrings(counts.keys()).map((value) => `'${value}' x${counts.get(value) ?? 0}`).join(', ')
}

function missingAndExtra(missing: Map<string, number>, extra: Map<string, number>): string {
  const details: string[] = []
  if (missing.size) details.push(`Missing: ${formattedCounts(missing)}.`)
  if (extra.size) details.push(`Unexpected: ${formattedCounts(extra)}.`)
  return details.join(' ')
}

function firstUnbalancedDelimiter(tokens: LaTeXStructuralToken[]): string | undefined {
  const closingForOpening: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
  const stack: string[] = []
  for (const token of tokens) {
    if (token.kind === 'openingDelimiter' && token.value in closingForOpening) stack.push(token.value)
    else if (token.kind === 'closingDelimiter') {
      const opening = stack.pop()
      if (opening === undefined || closingForOpening[opening] !== token.value) return token.value
    }
  }
  return stack[stack.length - 1]
}

function equalSequences(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export class StructuralLaTeXValidator implements LaTeXTranslationValidating {
  async validate(sourceUnits: LaTeXUnit[], translatedUnits: TranslatedLaTeXUnit[]): Promise<ValidationIssue[]> {
    const sourceByID = new Map<string, LaTeXUnit>()
    for (const unit of sourceUnits) sourceByID.set(unit.id, unit)
    const issues: ValidationIssue[] = []

    for (const translatedUnit of translatedUnits) {
      const sourceUnit = sourceByID.get(translatedUnit.id)
      if (!sourceUnit) continue
      const sourceTokens = tokenize(sourceUnit.source)
      const translatedTokens = tokenize(translatedUnit.translation)

      const sourcePlaceholders = tokenCounts(values(sourceTokens, placeholderValue))
      const translatedPlaceholders = tokenCounts(values(translatedTokens, placeholderValue))
      if (!sameCounts(sourcePlaceholders, translatedPlaceholders)) {
        issues.push(validationIssue({
          unitID: sourceUnit.id,
          severity: 'error',
          code: 'placeholder-mismatch',
          message: 'Protected LaTeX placeholders must be copied character-for-character with unchanged counts. '
            + missingAndExtra(positiveDifferences(sourcePlaceholders, translatedPlaceholders), positiveDifferences(translatedPlaceholders, sourcePlaceholders))
        }))
      }

      const sourceCommands = tokenCounts(values(sourceTokens, commandValue))
      const translatedCommands = tokenCounts(values(translatedTokens, commandValue))
      const missingCommands = positiveDifferences(sourceCommands, translatedCommands)
      if (missingCommands.size) {
        const replacementCandidates = positiveDifferences(translatedCommands, sourceCommands)
        let message = `LaTeX command names and counts must remain unchanged. Missing or changed: ${formattedCounts(missingCommands)}.`
        if (replacementCandidates.size) message += ` Possible replacements to revert: ${formattedCounts(replacementCandidates)}.`
        issues.push(validationIssue({ unitID: sourceUnit.id, severity: 'error', code: 'command-mismatch', message }))
      }

      const sourceNumericAssignments = values(sourceTokens, numericAssignmentValue)
      const translatedNumericAssignments = values(translatedTokens, numericAssignmentValue)
      if (!equalSequences(sourceNumericAssignments, translatedNumericAssignments)) {
        const describe = (items: string[]): string => (items.length ? items.map((item) => `'${item}'`).join(', ') : 'none')
        issues.push(validationIssue({
          unitID: sourceUnit.id,
          severity: 'error',
          code: 'numeric-assignment-mismatch',
          message: 'Numeric assignment arguments must remain unchanged and in source-relative order. '
            + `Expected: ${describe(sourceNumericAssignments)}. Received: ${describe(translatedNumericAssignments)}.`
        }))
      }

      const sourceMathDelimiterSequence = values(sourceTokens, mathDelimiterValue)
      const translatedMathDelimiterSequence = values(translatedTokens, mathDelimiterValue)
      const sourceMathDelimiters = tokenCounts(sourceMathDelimiterSequence)
      const translatedMathDelimiters = tokenCounts(translatedMathDelimiterSequence)
      if (!sameCounts(sourceMathDelimiters, translatedMathDelimiters)) {
        issues.push(validationIssue({
          unitID: sourceUnit.id,
          severity: 'error',
          code: 'math-delimiter-mismatch',
          message: "Math mode delimiters such as '$', '\\(', '\\)', '\\[', and '\\]' must remain unchanged. "
            + missingAndExtra(positiveDifferences(sourceMathDelimiters, translatedMathDelimiters), positiveDifferences(translatedMathDelimiters, sourceMathDelimiters))
        }))
      } else if (!equalSequences(sourceMathDelimiterSequence, translatedMathDelimiterSequence)) {
        issues.push(validationIssue({
          unitID: sourceUnit.id,
          severity: 'error',
          code: 'math-delimiter-mismatch',
          message: 'Math mode delimiters have the correct counts but changed order. Restore their source-relative order exactly.'
        }))
      }

      const delimiter = firstUnbalancedDelimiter(translatedTokens)
      if (delimiter !== undefined && firstUnbalancedDelimiter(sourceTokens) === undefined) {
        issues.push(validationIssue({
          unitID: sourceUnit.id,
          severity: 'error',
          code: 'unbalanced-delimiter',
          message: `The translation introduced an unbalanced '${delimiter}' delimiter. Restore the source delimiter structure exactly.`
        }))
      }
    }
    return issues
  }
}
