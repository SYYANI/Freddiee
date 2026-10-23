// Translation/PromptingLaTeXTranslator.swift
import { commandArgumentModel, parseSignedIntegerAssignment, type LaTeXCommandArgumentRole, type LaTeXUnmodeledArgumentPolicy } from './commandArguments'
import { encodeString, isJSONObject, parseJSON } from './json'
import {
  checkCancellation,
  type LaTeXTranslationCompleteness, type LaTeXUnit, type LaTeXUnitKind, type LaTeXUnitTranslating, type TranslatedLaTeXUnit,
  type TranslationContext
} from './models'
import { placeholderAt, tokenize } from './validation'
import {
  characterPrefix, characters, compareStrings, comparisonForm, isASCIILetter, isLetter, isNewline, isNumber, isWhitespace, slice,
  splitWhitespace, trimmed, type Characters
} from './text'

export type LaTeXPromptRole = 'system' | 'user'

export interface LaTeXPromptMessage {
  role: LaTeXPromptRole
  content: string
}

export type LaTeXPromptPurpose =
  | { kind: 'translation'; unitID: string; unitKind: LaTeXUnitKind; attempt: number }
  | { kind: 'summary' }

export interface LaTeXPromptRequest {
  purpose: LaTeXPromptPurpose
  messages: LaTeXPromptMessage[]
  temperature: number
  maximumOutputTokens: number
}

export function promptRequest(purpose: LaTeXPromptPurpose, messages: LaTeXPromptMessage[], temperature = 0.7, maximumOutputTokens = 8_192): LaTeXPromptRequest {
  return { purpose, messages, temperature, maximumOutputTokens: Math.max(1, maximumOutputTokens) }
}

export interface LaTeXPromptCompleting {
  complete(request: LaTeXPromptRequest, signal?: AbortSignal): Promise<string>
}

export interface LaTeXDocumentSummarizing {
  summarize(units: LaTeXUnit[], context: TranslationContext, signal?: AbortSignal): Promise<string | undefined>
}

export class PromptLaTeXDocumentSummarizer implements LaTeXDocumentSummarizing {
  /** Minimum word count at which a verbatim copy of the source is treated as an echo. */
  private static readonly minimumEchoWordCount = 12
  private readonly maximumInputCharacters: number

  constructor(private readonly client: LaTeXPromptCompleting, maximumInputCharacters = 60_000) {
    this.maximumInputCharacters = Math.max(1, maximumInputCharacters)
  }

  async summarize(units: LaTeXUnit[], context: TranslationContext, signal?: AbortSignal): Promise<string | undefined> {
    checkCancellation(signal)
    const document = units.map((unit) => unit.source).join('\n\n')
    if (!document) return undefined
    const truncated = characterPrefix(document, this.maximumInputCharacters)
    const instructions = [
      'Summarize the academic source text as compact context for translating the same document.',
      'State its objective, methods, claims, findings, and the referents of ambiguous expressions.',
      `Use the source language ${context.sourceLanguage}, remain factual, and stay under 300 words.`
    ].join('\n')
    const request = promptRequest({ kind: 'summary' }, [
      { role: 'system', content: instructions },
      { role: 'user', content: truncated }
    ], 0.2, 1_024)
    const response = trimmed(await this.client.complete(request, signal))
    if (!response || PromptLaTeXDocumentSummarizer.isEcho(response, truncated, instructions)) return undefined
    return response
  }

  /**
   * A summary that repeats the instructions or copies a long verbatim source passage would
   * only add noise to every translation prompt, so it is discarded.
   */
  static isEcho(summary: string, document: string, instructions: string): boolean {
    const summaryForm = comparisonForm(summary)
    const leadInstruction = characterSplit(instructions, '\n')[0] ?? instructions
    if (summaryForm.includes(comparisonForm(leadInstruction))) return true
    const wordCount = summaryForm.split(' ').filter(Boolean).length
    return wordCount >= PromptLaTeXDocumentSummarizer.minimumEchoWordCount && comparisonForm(document).includes(summaryForm)
  }
}

/** `split(separator:)` on characters, omitting empty pieces. */
function characterSplit(value: string, separator: string): string[] {
  const pieces: string[] = []
  let piece = ''
  for (const character of characters(value)) {
    if (character === separator) {
      if (piece) pieces.push(piece)
      piece = ''
    } else piece += character
  }
  if (piece) pieces.push(piece)
  return pieces
}

export interface TranslationCheckpointStoring {
  translation(unitID: string, fingerprint: string): Promise<string | undefined>
  saveTranslation(translation: string, unitID: string, fingerprint: string): Promise<void>
}

export const checkpointKey = (unitID: string, fingerprint: string): string => `${unitID}\u001f${fingerprint}`

export class InMemoryTranslationCheckpointStore implements TranslationCheckpointStoring {
  private readonly translations = new Map<string, string>()

  async translation(unitID: string, fingerprint: string): Promise<string | undefined> {
    return this.translations.get(checkpointKey(unitID, fingerprint))
  }

  async saveTranslation(translation: string, unitID: string, fingerprint: string): Promise<void> {
    this.translations.set(checkpointKey(unitID, fingerprint), translation)
  }

  storedTranslationCount(): number {
    return this.translations.size
  }
}

export type TranslationRuntimeErrorReason = { kind: 'emptyModelResponse'; unitID: string } | { kind: 'incompleteBatch' }

export class TranslationRuntimeError extends Error {
  constructor(readonly reason: TranslationRuntimeErrorReason) {
    super(reason.kind === 'emptyModelResponse'
      ? `The model returned an empty translation for ${reason.unitID}.`
      : 'The bounded translation runtime completed without producing every unit.')
    this.name = 'TranslationRuntimeError'
  }
}

const completenessRank: Record<LaTeXTranslationCompleteness, number> = { untranslated: 0, partial: 1, complete: 2 }

// MARK: Template

interface Replacement { placeholder: string; fragment: string }
interface ProtectedText { text: string; replacements: Replacement[] }
interface TranslationTextSlot { id: string; source: string }
type TranslationTemplatePart = { kind: 'literal'; value: string } | { kind: 'slot'; slot: TranslationTextSlot }

export interface TranslationTemplate {
  parts: TranslationTemplatePart[]
  slots: TranslationTextSlot[]
  protectedMath: ProtectedText
  protectedCommands: ProtectedText
  protectedVerbatim: ProtectedText
}

export function promptText(template: TranslationTemplate): string {
  return template.parts.map((part) => (part.kind === 'literal' ? part.value : `<TEXT_SLOT_${part.slot.id}>`)).join('')
}

interface SlotRendering {
  text: string
  completeness: LaTeXTranslationCompleteness
  translatedSlotCount: number
}

const isBetter = (rendering: SlotRendering, other: SlotRendering): boolean => {
  if (completenessRank[rendering.completeness] !== completenessRank[other.completeness]) {
    return completenessRank[rendering.completeness] > completenessRank[other.completeness]
  }
  return rendering.translatedSlotCount > other.translatedSlotCount
}

/** 64-bit FNV-1a over UTF-8, as 16 lowercase hex digits. */
export function fnv1a64(value: string): string {
  let high = 0xcbf29ce4
  let low = 0x84222325
  for (const byte of new TextEncoder().encode(value)) {
    low = (low ^ byte) >>> 0
    // Multiplies by the prime 2^40 + 0x1b3 modulo 2^64.
    const lowProduct = low * 0x1b3
    const carry = Math.floor(lowProduct / 0x1_0000_0000)
    high = (high * 0x1b3 + carry + ((low << 8) >>> 0)) >>> 0
    low = lowProduct >>> 0
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0')
}

export class PromptingLaTeXTranslator implements LaTeXUnitTranslating {
  private readonly client: LaTeXPromptCompleting
  private readonly summarizer?: LaTeXDocumentSummarizing
  private readonly checkpointStore?: TranslationCheckpointStoring
  private readonly maximumResponseAttempts: number
  private readonly collator: Intl.Collator

  /**
   * `maximumResponseAttempts` is the number of model calls allowed per unit when a response is
   * empty, not decodable, or leaves slots on source text. Only complete responses are
   * checkpointed, so incomplete units are requested again by the next run.
   *
   * Glossary entries are ordered as `localizedCaseInsensitiveCompare` orders them, in the
   * system locale unless `collationLocale` names another.
   */
  constructor(options: {
    client: LaTeXPromptCompleting
    summarizer?: LaTeXDocumentSummarizing
    checkpointStore?: TranslationCheckpointStoring
    maximumResponseAttempts?: number
    collationLocale?: string
  }) {
    this.client = options.client
    this.summarizer = options.summarizer
    this.checkpointStore = options.checkpointStore
    this.maximumResponseAttempts = Math.max(1, options.maximumResponseAttempts ?? 3)
    this.collator = new Intl.Collator(options.collationLocale, { sensitivity: 'accent' })
  }

  async translate(units: LaTeXUnit[], context: TranslationContext, signal?: AbortSignal): Promise<TranslatedLaTeXUnit[]> {
    if (!units.length) return []
    checkCancellation(signal)

    const configuredSummary = context.documentSummary === undefined ? '' : trimmed(context.documentSummary)
    const summary = configuredSummary || await this.summarizer?.summarize(units, context, signal)
    checkCancellation(signal)

    const templates = units.map((unit) => translationTemplate(unit.source))
    const requests = units.map((unit, index) => this.makePromptRequest(unit, templates[index], index, units, context, summary))
    const responseRetryRequest = (index: number): LaTeXPromptRequest => this.makePromptRequest(units[index], templates[index], index, units, context, summary, true)
    const concurrency = Math.min(context.maximumConcurrentTranslations, units.length)
    const ordered: Array<TranslatedLaTeXUnit | undefined> = new Array(units.length)

    // A failed unit cancels the rest of the batch, and the batch waits for them, as a throwing task group does.
    const group = new AbortController()
    const abortGroup = (): void => group.abort(signal?.reason)
    signal?.addEventListener('abort', abortGroup, { once: true })
    let failure: { error: unknown } | undefined
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (!failure && nextIndex < units.length) {
        const index = nextIndex
        nextIndex += 1
        try {
          ordered[index] = await this.translateOne(units[index], templates[index], requests[index], () => responseRetryRequest(index), group.signal)
          checkCancellation(signal)
        } catch (error) {
          if (!failure) {
            failure = { error }
            group.abort(error)
          }
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: concurrency }, worker))
    } finally {
      signal?.removeEventListener('abort', abortGroup)
    }
    checkCancellation(signal)
    if (failure) throw failure.error

    const completed = ordered.filter((unit): unit is TranslatedLaTeXUnit => unit !== undefined)
    if (completed.length !== units.length) throw new TranslationRuntimeError({ kind: 'incompleteBatch' })
    return completed
  }

  /** The checkpoint fingerprint of a request: 64-bit FNV-1a over its roles and contents. */
  static fingerprint(request: LaTeXPromptRequest): string {
    return fnv1a64(request.messages.map((message) => `${message.role}\u001e${message.content}`).join('\u001f'))
  }

  private async translateOne(
    unit: LaTeXUnit,
    template: TranslationTemplate,
    request: LaTeXPromptRequest,
    responseRetryRequest: () => LaTeXPromptRequest,
    signal: AbortSignal
  ): Promise<TranslatedLaTeXUnit> {
    checkCancellation(signal)
    const fingerprint = PromptingLaTeXTranslator.fingerprint(request)
    const checkpoint = await this.checkpointStore?.translation(unit.id, fingerprint)
    if (checkpoint && !isSourceOnlyCheckpoint(checkpoint, unit, template)) {
      return { id: unit.id, kind: unit.kind, source: unit.source, translation: checkpoint, completeness: 'complete' }
    }

    if (!template.slots.length) {
      await this.checkpointStore?.saveTranslation(unit.source, unit.id, fingerprint)
      return { id: unit.id, kind: unit.kind, source: unit.source, translation: unit.source, completeness: 'complete' }
    }

    let best: SlotRendering | undefined
    for (let attempt = 0; attempt < this.maximumResponseAttempts; attempt += 1) {
      checkCancellation(signal)
      const prompt = attempt === 0 ? request : responseRetryRequest()
      const response = trimmed(await this.client.complete(prompt, signal))
      checkCancellation(signal)
      if (!response) continue
      const rendering = renderResponse(response, template)
      if (!best || isBetter(rendering, best)) best = rendering
      if (rendering.completeness === 'complete') break
    }
    if (!best) throw new TranslationRuntimeError({ kind: 'emptyModelResponse', unitID: unit.id })

    // Incomplete output (an echoed prompt, invalid JSON, or source-text fallbacks) is returned
    // for this run but never checkpointed, so the next run asks the model again.
    if (best.completeness === 'complete') await this.checkpointStore?.saveTranslation(best.text, unit.id, fingerprint)
    return { id: unit.id, kind: unit.kind, source: unit.source, translation: best.text, completeness: best.completeness }
  }

  private makePromptRequest(
    unit: LaTeXUnit,
    template: TranslationTemplate,
    index: number,
    units: LaTeXUnit[],
    context: TranslationContext,
    summary: string | undefined,
    isResponseRetry = false
  ): LaTeXPromptRequest {
    const systemSections = [baseSystemPrompt(unit.kind, context)]

    const terminology = [...context.terminology].sort((a, b) => this.collator.compare(a.source, b.source) || compareStrings(a.target, b.target))
    if (terminology.length) {
      systemSections.push(`Use this glossary exactly when a source term appears:\n${terminology.map((entry) => `- ${entry.source} => ${entry.target}`).join('\n')}`)
    }
    if (summary) systemSections.push(`Document summary:\n${summary}`)

    if (template.protectedMath.replacements.length) {
      systemSections.push('Exact mathematical atoms appear only as <PLACEHOLDER_TRANSLATION_MATH_...> tokens in the immutable template. They include source-adjacent numeric content and are restored locally. Never copy a math token or literal math into a translation value.')
    }
    if (template.protectedCommands.replacements.length) {
      systemSections.push('Exact LaTeX commands and escaped control symbols appear only as <PLACEHOLDER_TRANSLATION_COMMAND_...> tokens in the immutable template and are restored locally. Never copy a command token, literal command, or equivalent LaTeX into a translation value.')
    }
    if (template.protectedVerbatim.replacements.length) {
      systemSections.push('Exact verbatim commands and arguments appear only as <PLACEHOLDER_TRANSLATION_VERBATIM_...> tokens in the immutable template and are restored locally. Never copy or translate a verbatim token or its literal content.')
    }
    systemSections.push('The runtime owns the immutable LaTeX template. Translate only the JSON text slots supplied by the user. Return one JSON array containing objects with exactly two string fields: "id" and "translation". Return every supplied ID exactly once and no other IDs. A translation value must contain natural-language text only: never emit LaTeX commands, placeholders, math delimiters, braces, brackets, ASCII parentheses, or Markdown. Do not return the immutable template.')

    // Response retries drop neighboring source because weak models most often echo it.
    const contextStart = Math.max(0, index - context.previousContextUnitCount)
    if (!isResponseRetry && contextStart < index) {
      systemSections.push(`Previous source context:\n${units.slice(contextStart, index).map((item) => item.source).join('\n\n')}`)
    }

    const issues = context.validationIssues.filter((issue) => issue.unitID === unit.id)
    const slotJSON = slotRequestJSON(template.slots)
    let userPrompt: string
    if (context.attempt > 0) {
      const previousTranslation = context.previousTranslations.find((translation) => translation.id === unit.id)?.translation ?? ''
      const issueText = issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n')
      userPrompt = [
        '[Immutable LaTeX template]',
        promptText(template),
        '[Translation slots JSON]',
        slotJSON,
        '[Previous translation]',
        previousTranslation,
        '[Validation errors]',
        issueText,
        'Translate every JSON slot coherently in template order. Use the previous translation only as linguistic context. The runtime reconstructs all immutable syntax locally.',
        'Return the JSON array only.'
      ].join('\n')
    } else {
      userPrompt = ['[Immutable LaTeX template]', promptText(template), '[Translation slots JSON]', slotJSON, 'Return the JSON array only.'].join('\n')
    }
    if (isResponseRetry) {
      userPrompt += '\nThe previous response was unusable: it was not a JSON array that translated every slot. Do not repeat these instructions or the source text.'
    }

    return promptRequest(
      { kind: 'translation', unitID: unit.id, unitKind: unit.kind, attempt: context.attempt },
      [{ role: 'system', content: systemSections.join('\n\n') }, { role: 'user', content: userPrompt }],
      context.attempt > 0 || isResponseRetry ? 0.1 : 0.7
    )
  }
}

function baseSystemPrompt(kind: LaTeXUnitKind, context: TranslationContext): string {
  return [
    `You are an academic LaTeX translator. Translate natural-language content from ${context.sourceLanguage} to ${context.targetLanguage}.`,
    `Unit kind: ${kind}.`,
    'Translate section and caption prose when present. Keep author names unchanged and use consistent academic terminology.',
    'Follow the structured response contract exactly, with no explanation, comment, or Markdown fence.'
  ].join('\n')
}

/**
 * Checkpoints written before incomplete responses were excluded may contain an all-source
 * fallback. A unit with prose slots whose checkpoint is byte-identical to its source was
 * never translated, so it is requested again.
 */
function isSourceOnlyCheckpoint(checkpoint: string, unit: LaTeXUnit, template: TranslationTemplate): boolean {
  return checkpoint === unit.source && template.slots.some((slot) => isProse(slot.source))
}

/** Slots as `JSONEncoder` with `.sortedKeys` writes them. */
function slotRequestJSON(slots: TranslationTextSlot[]): string {
  return `[${slots.map((slot) => `{"id":${encodeString(slot.id)},"source":${encodeString(slot.source)}}`).join(',')}]`
}

/** Minimum word count at which an unchanged slot is treated as untranslated prose. */
const minimumProseWordCount = 6

function isProse(value: string): boolean {
  return splitWhitespace(value).filter((word) => characters(word).some(isLetter)).length >= minimumProseWordCount
}

interface SlotCompletion { id: string; translation: string }

function slotCompletions(text: string): SlotCompletion[] | undefined {
  const value = parseJSON(text)
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => isJSONObject(item) && typeof item.id === 'string' && typeof item.translation === 'string')) return undefined
  return value as unknown as SlotCompletion[]
}

function decodedSlotCompletions(response: string): SlotCompletion[] {
  const whole = slotCompletions(response)
  if (whole) return whole
  const chars = characters(response)
  const start = chars.indexOf('[')
  const end = chars.lastIndexOf(']')
  if (start < 0 || end < 0 || start > end) return []
  return slotCompletions(slice(chars, start, end + 1)) ?? []
}

const reservedSlotCharacters = new Set(['\\', '{', '}', '[', ']', '(', ')', '<', '>', '$', '%', '&', '#', '_', '^', '~'])

function isSafeSlotTranslation(value: string): boolean {
  if (value.includes('<PLACEHOLDER_')) return false
  return !characters(value).some((character) => reservedSlotCharacters.has(character)) && tokenize(value).length === 0
}

function renderResponse(response: string, template: TranslationTemplate): SlotRendering {
  const translations = new Map<string, string>()
  const duplicateIDs = new Set<string>()
  for (const completion of decodedSlotCompletions(response)) {
    if (translations.has(completion.id)) duplicateIDs.add(completion.id)
    translations.set(completion.id, completion.translation)
  }

  let rendered = ''
  let fallbackSlotCount = 0
  let translatedSlotCount = 0
  let unchangedProseSlotCount = 0
  for (const part of template.parts) {
    if (part.kind === 'literal') {
      rendered += part.value
      continue
    }
    const { slot } = part
    const raw = translations.get(slot.id)
    const candidate = raw === undefined ? undefined : trimmed(raw)
    if (!duplicateIDs.has(slot.id) && candidate && isSafeSlotTranslation(candidate)) {
      rendered += candidate
      if (comparisonForm(candidate) !== comparisonForm(slot.source)) translatedSlotCount += 1
      else if (isProse(slot.source)) unchangedProseSlotCount += 1
    } else {
      rendered += slot.source
      fallbackSlotCount += 1
    }
  }
  for (const replacements of [template.protectedCommands.replacements, template.protectedMath.replacements, template.protectedVerbatim.replacements]) {
    for (const replacement of replacements) rendered = rendered.split(replacement.placeholder).join(replacement.fragment)
  }

  // Unchanged short slots may be names or identifiers; unchanged prose with nothing
  // translated alongside it means the model echoed its input.
  let completeness: LaTeXTranslationCompleteness
  if (translatedSlotCount === 0 && (fallbackSlotCount > 0 || unchangedProseSlotCount > 0)) completeness = 'untranslated'
  else if (fallbackSlotCount > 0) completeness = 'partial'
  else completeness = 'complete'
  return { text: rendered, completeness, translatedSlotCount }
}

/**
 * Builds the immutable template: verbatim atoms, math atoms (with adjacent numbers) and
 * commands become placeholders; command arguments are kept or recursed into by role; the
 * remaining prose becomes ID-addressed slots.
 */
export function translationTemplate(source: string): TranslationTemplate {
  const protectedVerbatim = protectingVerbatimAtoms(source)
  const protectedMath = protectingMathAtoms(protectedVerbatim.text)
  const protectedCommands = protectingLaTeXCommands(protectedMath.text)
  const commandFragments = new Map(protectedCommands.replacements.map((replacement) => [replacement.placeholder, replacement.fragment]))
  const builder = new TemplateBuilder(characters(protectedCommands.text), commandFragments)
  builder.appendContent(0, builder.chars.length)
  return { parts: builder.parts, slots: builder.slots, protectedMath, protectedCommands, protectedVerbatim }
}

const immutableTemplateCharacters = new Set(['\\', '{', '}', '[', ']', '(', ')', '<', '>', '$', '&', '#', '_', '^', '~', '\n', '\r'])

class TemplateBuilder {
  readonly parts: TranslationTemplatePart[] = []
  readonly slots: TranslationTextSlot[] = []

  constructor(readonly chars: Characters, private readonly commandFragments: Map<string, string>) {}

  appendContent(start: number, limit: number): void {
    const { chars } = this
    let index = start
    while (index < limit) {
      if (chars[index] === '%') {
        const boundedEnd = Math.min(endOfComment(chars, index), limit)
        this.appendLiteral(slice(chars, index, boundedEnd))
        index = boundedEnd
        continue
      }
      if (chars[index] === '<') {
        const placeholder = placeholderAt(chars, index)
        if (placeholder) {
          this.appendLiteral(placeholder.value)
          index = placeholder.end
          const fragment = this.commandFragments.get(placeholder.value)
          if (fragment !== undefined) index = this.appendCommandArguments(fragment, index, limit)
          continue
        }
      }
      if (immutableTemplateCharacters.has(chars[index])) {
        this.appendLiteral(chars[index])
        index += 1
        continue
      }
      const textStart = index
      while (index < limit && chars[index] !== '%' && chars[index] !== '<' && !immutableTemplateCharacters.has(chars[index])) index += 1
      this.appendText(chars.slice(textStart, index))
    }
  }

  private appendLiteral(value: string): void {
    if (!value) return
    const last = this.parts[this.parts.length - 1]
    if (last?.kind === 'literal') last.value += value
    else this.parts.push({ kind: 'literal', value })
  }

  private appendText(value: Characters): void {
    if (!value.length) return
    let leadingEnd = 0
    while (leadingEnd < value.length && isWhitespace(value[leadingEnd])) leadingEnd += 1
    let trailingStart = value.length
    while (trailingStart > leadingEnd && isWhitespace(value[trailingStart - 1])) trailingStart -= 1
    const core = value.slice(leadingEnd, trailingStart)
    this.appendLiteral(slice(value, 0, leadingEnd))
    if (!shouldTranslateText(core)) {
      this.appendLiteral(core.join(''))
      this.appendLiteral(slice(value, trailingStart))
      return
    }
    const slot = { id: String(this.slots.length + 1), source: core.join('') }
    this.slots.push(slot)
    this.parts.push({ kind: 'slot', slot })
    this.appendLiteral(slice(value, trailingStart))
  }

  private appendCommandArguments(fragment: string, start: number, limit: number): number {
    const { chars } = this
    const name = commandName(fragment)
    if (name === undefined) return start
    const model = commandArgumentModel(name, environmentName(fragment))
    let cursor = start
    for (const argument of model.arguments) {
      switch (argument.syntax) {
        case 'requiredGroup':
        case 'optionalGroup': {
          const groupStart = whitespaceEnd(chars, cursor, limit)
          const opening = argument.syntax === 'optionalGroup' ? '[' : '{'
          if (groupStart >= limit || chars[groupStart] !== opening) {
            if (argument.syntax === 'optionalGroup') continue
            return this.appendUnmodeledArguments(model.unmodeledArguments, cursor, limit)
          }
          const group = templateGroup(chars, groupStart, limit)
          if (!group) {
            this.appendLiteral(slice(chars, cursor, limit))
            return limit
          }
          this.appendLiteral(slice(chars, cursor, groupStart))
          this.appendGroup(group, argument.role)
          cursor = group.end
          break
        }
        case 'delimited': {
          const delimiterStart = whitespaceEnd(chars, cursor, limit)
          this.appendLiteral(slice(chars, cursor, delimiterStart))
          if (delimiterStart >= limit) return delimiterStart
          const verbatimEnd = endOfDelimitedArgument(chars, delimiterStart, limit)
          this.appendLiteral(slice(chars, delimiterStart, verbatimEnd))
          cursor = verbatimEnd
          break
        }
        case 'requiredGroupOrDelimited': {
          const argumentStart = whitespaceEnd(chars, cursor, limit)
          this.appendLiteral(slice(chars, cursor, argumentStart))
          if (argumentStart >= limit) return argumentStart
          const group = chars[argumentStart] === '{' ? templateGroup(chars, argumentStart, limit) : undefined
          if (group) {
            this.appendGroup(group, argument.role)
            cursor = group.end
          } else {
            const verbatimEnd = endOfDelimitedArgument(chars, argumentStart, limit)
            this.appendLiteral(slice(chars, argumentStart, verbatimEnd))
            cursor = verbatimEnd
          }
          break
        }
        case 'signedIntegerAssignment': {
          const assignment = argument.role === 'structural' ? parseSignedIntegerAssignment(chars, cursor, limit) : undefined
          if (!assignment) return this.appendUnmodeledArguments(model.unmodeledArguments, cursor, limit)
          this.appendLiteral(slice(chars, assignment.start, assignment.end))
          cursor = assignment.end
          break
        }
      }
    }
    return this.appendUnmodeledArguments(model.unmodeledArguments, cursor, limit)
  }

  private appendGroup(group: TemplateGroup, role: LaTeXCommandArgumentRole): void {
    if (role === 'translatableText') {
      this.appendLiteral(this.chars[group.start])
      this.appendContent(group.start + 1, group.end - 1)
      this.appendLiteral(this.chars[group.end - 1])
    } else {
      this.appendLiteral(slice(this.chars, group.start, group.end))
    }
  }

  private appendUnmodeledArguments(policy: LaTeXUnmodeledArgumentPolicy, start: number, limit: number): number {
    if (policy !== 'preserveAdjacentGroups') return start
    const { chars } = this
    let cursor = start
    while (cursor < limit) {
      const groupStart = whitespaceEnd(chars, cursor, limit)
      const group = groupStart < limit && (chars[groupStart] === '[' || chars[groupStart] === '{') ? templateGroup(chars, groupStart, limit) : undefined
      if (!group) return cursor
      this.appendLiteral(slice(chars, cursor, group.end))
      cursor = group.end
    }
    return cursor
  }
}

function shouldTranslateText(value: Characters): boolean {
  if (!value.some(isLetter)) return false
  if (value.length === 1 && isASCIILetter(value[0])) return false
  if (!value.some(isWhitespace) && value.some((character) => [':', '/', '_', '@'].includes(character))) return false
  return true
}

function environmentName(fragment: string): string | undefined {
  if (!fragment.startsWith('\\begin{')) return undefined
  const chars = characters(fragment)
  const closingBrace = chars.indexOf('}')
  if (closingBrace < 0 || closingBrace <= 7) return undefined
  return slice(chars, 7, closingBrace)
}

function commandName(fragment: string): string | undefined {
  const chars = characters(fragment)
  if (chars[0] !== '\\' || chars.length <= 1) return undefined
  let cursor = 1
  while (cursor < chars.length && isCommandNameCharacter(chars[cursor])) cursor += 1
  if (cursor <= 1) return undefined
  return slice(chars, 1, cursor)
}

interface TemplateGroup { start: number; end: number }

function whitespaceEnd(chars: Characters, start: number, limit: number): number {
  let cursor = start
  while (cursor < limit && isWhitespace(chars[cursor])) cursor += 1
  return cursor
}

/** A `[...]` or `{...}` group; inside brackets, braces nest independently. */
function templateGroup(chars: Characters, start: number, limit: number): TemplateGroup | undefined {
  if (start >= limit || (chars[start] !== '[' && chars[start] !== '{')) return undefined
  const opening = chars[start]
  const closing = opening === '[' ? ']' : '}'
  let depth = 1
  let braceDepth = 0
  for (let cursor = start + 1; cursor < limit; cursor += 1) {
    if (opening === '[' && chars[cursor] === '{') braceDepth += 1
    else if (opening === '[' && chars[cursor] === '}' && braceDepth > 0) braceDepth -= 1
    else if (braceDepth === 0 && chars[cursor] === opening) depth += 1
    else if (braceDepth === 0 && chars[cursor] === closing) {
      depth -= 1
      if (depth === 0) return { start, end: cursor + 1 }
    }
  }
  return undefined
}

function endOfDelimitedArgument(chars: Characters, start: number, limit: number): number {
  if (start >= limit) return start
  const delimiter = chars[start]
  let cursor = start + 1
  while (cursor < limit && chars[cursor] !== delimiter) cursor += 1
  return cursor < limit ? cursor + 1 : limit
}

// MARK: Protection

function placeholderAvoiding(prefix: string, number: number, source: string): string {
  let placeholder = `<${prefix}_${number}>`
  while (source.includes(placeholder)) placeholder = `${placeholder.slice(0, -1)}_>`
  return placeholder
}

function protectingVerbatimAtoms(source: string): ProtectedText {
  const chars = characters(source)
  let protectedText = ''
  const replacements: Replacement[] = []
  let index = 0
  while (index < chars.length) {
    if (chars[index] === '%' && !isEscaped(chars, index)) {
      const end = endOfComment(chars, index)
      protectedText += slice(chars, index, end)
      index = end
      continue
    }
    const end = endOfVerbatimCommand(chars, index)
    if (end === undefined) {
      protectedText += chars[index]
      index += 1
      continue
    }
    const placeholder = placeholderAvoiding('PLACEHOLDER_TRANSLATION_VERBATIM', replacements.length + 1, source)
    protectedText += placeholder
    replacements.push({ placeholder, fragment: slice(chars, index, end) })
    index = end
  }
  return { text: protectedText, replacements }
}

function endOfVerbatimCommand(chars: Characters, start: number): number | undefined {
  if (start >= chars.length || chars[start] !== '\\' || isEscaped(chars, start)) return undefined
  const command = rawCommandName(chars, start)
  if (!command) return undefined
  // After an optional `[...]`; an unterminated one runs to the end of the text.
  const afterOptionalGroup = (from: number): number | 'unterminated' => {
    const optionalStart = rawWhitespaceEnd(chars, from)
    if (optionalStart >= chars.length || chars[optionalStart] !== '[') return from
    return rawGroupEnd(chars, optionalStart) ?? 'unterminated'
  }
  switch (command.name) {
    case 'verb':
      return endOfRawDelimitedArgument(chars, command.end, false)
    case 'Verb':
    case 'lstinline': {
      const cursor = afterOptionalGroup(command.end)
      if (cursor === 'unterminated') return chars.length
      return endOfRawDelimitedArgument(chars, cursor, true)
    }
    case 'url':
    case 'path':
    case 'nolinkurl':
    case 'texttt': {
      const groupStart = rawWhitespaceEnd(chars, command.end)
      if (groupStart >= chars.length || chars[groupStart] !== '{') return undefined
      return rawGroupEnd(chars, groupStart)
    }
    case 'mintinline': {
      const cursor = afterOptionalGroup(command.end)
      if (cursor === 'unterminated') return chars.length
      const languageStart = rawWhitespaceEnd(chars, cursor)
      const languageEnd = languageStart < chars.length && chars[languageStart] === '{' ? rawGroupEnd(chars, languageStart) : undefined
      if (languageEnd === undefined) return undefined
      return endOfRawDelimitedArgument(chars, languageEnd, true)
    }
    default:
      return undefined
  }
}

function rawCommandName(chars: Characters, start: number): { name: string; end: number } | undefined {
  if (start + 1 >= chars.length || !isASCIILetter(chars[start + 1])) return undefined
  let cursor = start + 2
  while (cursor < chars.length && isASCIILetter(chars[cursor])) cursor += 1
  const name = slice(chars, start + 1, cursor)
  if (cursor < chars.length && chars[cursor] === '*') cursor += 1
  return { name, end: cursor }
}

function rawWhitespaceEnd(chars: Characters, start: number): number {
  let cursor = start
  while (cursor < chars.length && isWhitespace(chars[cursor])) cursor += 1
  return cursor
}

/** The end of a `[...]` or `{...}` group that skips escaped characters. */
function rawGroupEnd(chars: Characters, start: number): number | undefined {
  if (start >= chars.length || (chars[start] !== '[' && chars[start] !== '{')) return undefined
  const opening = chars[start]
  const closing = opening === '[' ? ']' : '}'
  let depth = 1
  let braceDepth = 0
  let cursor = start + 1
  while (cursor < chars.length) {
    if (isEscaped(chars, cursor)) {
      cursor += 1
      continue
    }
    if (opening === '[' && chars[cursor] === '{') braceDepth += 1
    else if (opening === '[' && chars[cursor] === '}' && braceDepth > 0) braceDepth -= 1
    else if (braceDepth === 0 && chars[cursor] === opening) depth += 1
    else if (braceDepth === 0 && chars[cursor] === closing) {
      depth -= 1
      if (depth === 0) return cursor + 1
    }
    cursor += 1
  }
  return undefined
}

function endOfRawDelimitedArgument(chars: Characters, start: number, skippingWhitespace: boolean): number | undefined {
  const delimiterStart = skippingWhitespace ? rawWhitespaceEnd(chars, start) : start
  if (delimiterStart >= chars.length) return undefined
  if (chars[delimiterStart] === '{') return rawGroupEnd(chars, delimiterStart)
  const delimiter = chars[delimiterStart]
  let cursor = delimiterStart + 1
  while (cursor < chars.length && chars[cursor] !== delimiter) cursor += 1
  return cursor < chars.length ? cursor + 1 : chars.length
}

function protectingLaTeXCommands(source: string): ProtectedText {
  const chars = characters(source)
  let protectedText = ''
  const replacements: Replacement[] = []
  let index = 0
  while (index < chars.length) {
    if (chars[index] === '%' && !isEscaped(chars, index)) {
      const end = endOfComment(chars, index)
      protectedText += slice(chars, index, end)
      index = end
      continue
    }
    if (chars[index] !== '\\' || isEscaped(chars, index) || index + 1 >= chars.length) {
      protectedText += chars[index]
      index += 1
      continue
    }
    let end: number
    if (isCommandNameCharacter(chars[index + 1])) {
      let commandEnd = index + 2
      while (commandEnd < chars.length && isCommandNameCharacter(chars[commandEnd])) commandEnd += 1
      if (commandEnd < chars.length && chars[commandEnd] === '*') commandEnd += 1
      const command = slice(chars, index + 1, commandEnd).replaceAll('*', '')
      if (command === 'verb') end = endOfVerb(chars, index) ?? commandEnd
      else if (command === 'begin' || command === 'end') end = endOfEnvironmentBoundary(chars, commandEnd) ?? commandEnd
      else end = commandEnd
    } else {
      end = index + 2
    }
    const placeholder = placeholderAvoiding('PLACEHOLDER_TRANSLATION_COMMAND', replacements.length + 1, source)
    protectedText += placeholder
    replacements.push({ placeholder, fragment: slice(chars, index, end) })
    index = end
  }
  return { text: protectedText, replacements }
}

function endOfEnvironmentBoundary(chars: Characters, commandEnd: number): number | undefined {
  let cursor = commandEnd
  while (cursor < chars.length && isWhitespace(chars[cursor])) cursor += 1
  if (cursor >= chars.length || chars[cursor] !== '{') return undefined
  cursor += 1
  while (cursor < chars.length && chars[cursor] !== '}') cursor += 1
  if (cursor >= chars.length) return undefined
  return cursor + 1
}

function protectingMathAtoms(source: string): ProtectedText {
  const chars = characters(source)
  // Characters, so that a number before a math fragment can be taken back into the atom.
  const protectedCharacters: string[] = []
  const replacements: Replacement[] = []
  let index = 0
  while (index < chars.length) {
    if (chars[index] === '%' && !isEscaped(chars, index)) {
      const end = endOfComment(chars, index)
      for (let cursor = index; cursor < end; cursor += 1) protectedCharacters.push(chars[cursor])
      index = end
      continue
    }
    const verbEnd = endOfVerb(chars, index)
    if (verbEnd !== undefined) {
      for (let cursor = index; cursor < verbEnd; cursor += 1) protectedCharacters.push(chars[cursor])
      index = verbEnd
      continue
    }
    const end = endOfMathFragment(chars, index)
    if (end !== undefined) {
      const atomStart = startOfMathAtom(chars, index)
      const atomEnd = endOfMathAtom(chars, end)
      if (atomStart < index) protectedCharacters.splice(protectedCharacters.length - (index - atomStart))
      const placeholder = placeholderAvoiding('PLACEHOLDER_TRANSLATION_MATH', replacements.length + 1, source)
      for (const character of characters(placeholder)) protectedCharacters.push(character)
      replacements.push({ placeholder, fragment: slice(chars, atomStart, atomEnd) })
      index = atomEnd
      continue
    }
    protectedCharacters.push(chars[index])
    index += 1
  }
  return { text: protectedCharacters.join(''), replacements }
}

function startOfMathAtom(chars: Characters, mathStart: number): number {
  let cursor = mathStart
  while (cursor > 0) {
    if (isNumber(chars[cursor - 1])) {
      cursor -= 1
      continue
    }
    if (cursor > 1 && isMathAtomOperator(chars[cursor - 1]) && isNumber(chars[cursor - 2])) {
      cursor -= 1
      continue
    }
    break
  }
  if (cursor < mathStart) return cursor
  if (cursor > 0 && isASCIILetter(chars[cursor - 1]) && (cursor < 2 || !isASCIILetterOrDigit(chars[cursor - 2]))) return cursor - 1
  return mathStart
}

function endOfMathAtom(chars: Characters, firstMathEnd: number): number {
  let cursor = firstMathEnd
  for (;;) {
    while (cursor < chars.length) {
      if (isNumber(chars[cursor])) {
        cursor += 1
        continue
      }
      if (cursor + 1 < chars.length && isMathAtomOperator(chars[cursor]) && isNumber(chars[cursor + 1])) {
        cursor += 1
        continue
      }
      break
    }
    if (cursor + 1 < chars.length && chars[cursor] === '\\' && chars[cursor + 1] === '%') cursor += 2
    const nextMathEnd = cursor < chars.length ? endOfMathFragment(chars, cursor) : undefined
    if (nextMathEnd === undefined) return cursor
    cursor = nextMathEnd
  }
}

const isMathAtomOperator = (character: string): boolean => ['-', '+', '.', '/', ':', '–', '—'].includes(character)
const isASCIILetterOrDigit = (character: string): boolean => isASCIILetter(character) || isNumber(character)
const isCommandNameCharacter = (character: string): boolean => isASCIILetter(character) || character === '@' || character === '_' || character === ':'

function endOfMathFragment(chars: Characters, start: number): number | undefined {
  if (chars[start] === '$' && !isEscaped(chars, start)) {
    const delimiterLength = start + 1 < chars.length && chars[start + 1] === '$' ? 2 : 1
    return closingMathDelimiter(chars, start + delimiterLength, delimiterLength === 2 ? ['$', '$'] : ['$'])
  }
  if (chars[start] !== '\\' || isEscaped(chars, start) || start + 1 >= chars.length) return undefined
  if (chars[start + 1] === '(') return closingMathDelimiter(chars, start + 2, ['\\', ')'])
  if (chars[start + 1] === '[') return closingMathDelimiter(chars, start + 2, ['\\', ']'])
  return undefined
}

function closingMathDelimiter(chars: Characters, contentStart: number, closing: string[]): number | undefined {
  let cursor = contentStart
  while (cursor < chars.length) {
    if (chars[cursor] === '%') {
      cursor = endOfComment(chars, cursor)
      continue
    }
    if (chars[cursor] === '\\' && (closing[0] !== '\\' || !hasPrefix(closing, chars, cursor))) {
      cursor = Math.min(cursor + 2, chars.length)
      continue
    }
    if (hasPrefix(closing, chars, cursor)) return cursor + closing.length
    cursor += 1
  }
  return undefined
}

function hasPrefix(prefix: string[], chars: Characters, start: number): boolean {
  if (start + prefix.length > chars.length) return false
  return prefix.every((character, offset) => chars[start + offset] === character)
}

function endOfComment(chars: Characters, start: number): number {
  let cursor = start
  while (cursor < chars.length && !isNewline(chars[cursor])) cursor += 1
  return cursor
}

function endOfVerb(chars: Characters, start: number): number | undefined {
  if (chars[start] !== '\\' || isEscaped(chars, start) || start + 5 >= chars.length) return undefined
  if (slice(chars, start, Math.min(start + 5, chars.length)) !== '\\verb') return undefined
  if (chars[start + 5] !== '*' && isASCIILetter(chars[start + 5])) return undefined
  let delimiterIndex = start + 5
  if (delimiterIndex < chars.length && chars[delimiterIndex] === '*') delimiterIndex += 1
  if (delimiterIndex >= chars.length) return chars.length
  const delimiter = chars[delimiterIndex]
  let cursor = delimiterIndex + 1
  while (cursor < chars.length && chars[cursor] !== delimiter) cursor += 1
  return cursor < chars.length ? cursor + 1 : chars.length
}

function isEscaped(chars: Characters, index: number): boolean {
  let slashCount = 0
  let cursor = index
  while (cursor > 0 && chars[cursor - 1] === '\\') {
    slashCount += 1
    cursor -= 1
  }
  return slashCount % 2 !== 0
}
