// Reconstruction/StructuredLaTeXReconstructor.swift
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { atomicWriteFile } from '../../electron/main/files'
import { resolvedPath } from './parser'
import {
  TranslationLanguages, checkCancellation,
  type LaTeXCaption, type LaTeXEnvironment, type LaTeXInputBoundary, type LaTeXNewCommand, type LaTeXProjectReconstructing,
  type LaTeXSection, type ParsedLaTeXProject, type PreparedProject, type TranslatedLaTeXUnit, type TranslationConfiguration,
  type TranslationLanguage
} from './models'
import { characters, isAlphabeticScalar, safeComponent, sortedStrings, trimmed } from './text'

export interface LaTeXPreambleTransforming {
  transform(source: string, targetLanguage: TranslationLanguage): string
}

/** Keeps an ASCII control word that a translation runs into Unicode letters a valid control word. */
export function normalizeTranslationBoundary(translation: string): string {
  const chars = characters(translation)
  let result = ''
  let index = 0
  const isControlWordCharacter = (character: string): boolean => {
    if (character.length !== 1) return false
    const code = character.charCodeAt(0)
    return code < 0x80 && (code === 64 || isAlphabeticScalar(code))
  }
  const startsWithNonASCIIAlphabeticScalar = (character: string): boolean =>
    Array.from(character).some((scalar) => {
      const code = scalar.codePointAt(0)!
      return code >= 0x80 && isAlphabeticScalar(code)
    })
  while (index < chars.length) {
    const character = chars[index]
    result += character
    index += 1
    if (character !== '\\') continue
    let consumedControlWord = false
    while (index < chars.length && isControlWordCharacter(chars[index])) {
      consumedControlWord = true
      result += chars[index]
      index += 1
    }
    if (consumedControlWord && index < chars.length && startsWithNonASCIIAlphabeticScalar(chars[index])) result += ' '
  }
  return result
}

// NSRegularExpression patterns; ICU's \s is the White_Space property.
const S = '\\p{White_Space}'
const ctexPattern = String.raw`\\usepackage(?:\[([^\]]*)\])?\{ctex\}`
const cjkUTF8PackagePattern = String.raw`\\(?:usepackage|RequirePackage)${S}*(?:\[[^\]]*\]${S}*)?\{CJKutf8\}`
const cjkEnvironmentBeginPattern = String.raw`\\begin${S}*\{CJK\*?\}${S}*\{[^{}]+\}${S}*\{[^{}]+\}`
const cjkEnvironmentEndPattern = String.raw`\\end${S}*\{CJK\*?\}`
const documentClassPattern = String.raw`\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}`

const portableChinesePackage = String.raw`% LaTeXTransKit: preserve source line spacing across injected ctex
\makeatletter
\let\LaTeXTransKit@baselinestretch\baselinestretch
\makeatother
\usepackage[UTF8,fontset=fandol]{ctex}
\makeatletter
\let\baselinestretch\LaTeXTransKit@baselinestretch
\normalsize
\makeatother`
const fontAwesomeCompatibilityMarker = '% LaTeXTransKit: portable Unicode font compatibility'
const fontAwesomeCompatibility = String.raw`% LaTeXTransKit: portable Unicode font compatibility
\ifdefined\XeTeXversion
  \RequirePackage{fontspec}
  \defaultfontfeatures[FontAwesome]{Extension=.otf}
\else
  \ifdefined\directlua
    \RequirePackage{fontspec}
    \defaultfontfeatures[FontAwesome]{Extension=.otf}
  \fi
\fi`
const xeTeXLegacyMicrotypeCompatibilityMarker = '% LaTeXTransKit: XeTeX legacy Type 1 microtype compatibility'
const xeTeXLegacyMicrotypeCompatibility = String.raw`% LaTeXTransKit: XeTeX legacy Type 1 microtype compatibility
\ifdefined\XeTeXversion
  \PassOptionsToPackage{protrusion=false}{microtype}
\fi`

export class ReferenceLanguagePreamblePolicy implements LaTeXPreambleTransforming {
  transform(source: string, targetLanguage: TranslationLanguage): string {
    switch (targetLanguage) {
      case TranslationLanguages.simplifiedChinese: {
        const withoutLegacyCJK = removingLegacyCJKUTF8(source)
        const withCTeX = addingPortableChinesePreamble(withoutLegacyCJK)
        const withUnicodeFonts = addingUnicodeFontCompatibility(withCTeX)
        return addingXeTeXLegacyMicrotypeCompatibility(withUnicodeFonts)
      }
      case TranslationLanguages.japanese: {
        const withLuaTeXJA = addingPackage(String.raw`\usepackage{luatexja}`, String.raw`\\usepackage(?:\[[^\]]*\])?\{luatexja\}`, source)
        return addingUnicodeFontCompatibility(withLuaTeXJA)
      }
      default:
        return source
    }
  }
}

function removingLegacyCJKUTF8(source: string): string {
  return [cjkUTF8PackagePattern, cjkEnvironmentBeginPattern, cjkEnvironmentEndPattern]
    .reduce((result, pattern) => result.replace(new RegExp(pattern, 'gu'), ''), source)
}

function addingPortableChinesePreamble(source: string): string {
  const match = new RegExp(ctexPattern, 'u').exec(source)
  if (!match) return addingPackage(portableChinesePackage, ctexPattern, source)
  const packageText = match[0]
  const existingOptions = /(?<=\[)[^\]]*(?=\]\{ctex\})/u.exec(packageText)?.[0] ?? ''
  const options = existingOptions.split(',').map(trimmed).filter(Boolean)
  if (!options.some((option) => option.toLowerCase() === 'utf8')) options.unshift('UTF8')
  if (!options.some((option) => option.toLowerCase().startsWith('fontset='))) options.push('fontset=fandol')
  const replacement = `\\usepackage[${options.join(',')}]{ctex}`
  return source.slice(0, match.index) + replacement + source.slice(match.index + packageText.length)
}

function addingUnicodeFontCompatibility(source: string): string {
  if (source.includes(fontAwesomeCompatibilityMarker)) return source
  return insertingAfterDocumentClass(fontAwesomeCompatibility, source)
}

function addingXeTeXLegacyMicrotypeCompatibility(source: string): string {
  if (source.includes(xeTeXLegacyMicrotypeCompatibilityMarker)) return source
  return insertingAfterDocumentClass(xeTeXLegacyMicrotypeCompatibility, source)
}

function addingPackage(packageText: string, existingPattern: string, source: string): string {
  if (new RegExp(existingPattern, 'u').test(source)) return source
  return insertingAfterDocumentClass(packageText, source)
}

function insertingAfterDocumentClass(addition: string, source: string): string {
  const match = new RegExp(documentClassPattern, 'u').exec(source)
  if (!match) return source
  const end = match.index + match[0].length
  return `${source.slice(0, end)}\n${addition}\n${source.slice(end)}`
}

// MARK: Copying

export interface TranslationProjectCopying {
  copyProject(source: string, destination: string, signal?: AbortSignal): Promise<void>
}

export type ReconstructionErrorReason =
  | { kind: 'invalidTranslationSet'; expected: string[]; received: string[] }
  | { kind: 'outputDirectoryInsideSource'; path: string }
  | { kind: 'symbolicLinkNotSupported'; path: string }
  | { kind: 'unsafeOutputPath'; path: string }
  | { kind: 'missingPlaceholder'; placeholder: string }
  | { kind: 'mismatchedInputBoundary'; begin: string; end: string }
  | { kind: 'residualPlaceholders'; placeholders: string[] }
  | { kind: 'mainFileOutsideProject'; path: string }

export class ReconstructionError extends Error {
  constructor(readonly reason: ReconstructionErrorReason) {
    super(ReconstructionError.describe(reason))
    this.name = 'ReconstructionError'
  }

  private static describe(reason: ReconstructionErrorReason): string {
    const list = (values: string[]): string => `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
    switch (reason.kind) {
      case 'invalidTranslationSet': return `Reconstruction expected translation IDs ${list(reason.expected)} but received ${list(reason.received)}.`
      case 'outputDirectoryInsideSource': return `The translation output directory cannot be inside the prepared source tree: ${reason.path}.`
      case 'symbolicLinkNotSupported': return `Project resource symlinks are not supported: ${reason.path}.`
      case 'unsafeOutputPath': return `Reconstruction rejected an unsafe project-relative path: ${reason.path}.`
      case 'missingPlaceholder': return `A required reconstruction placeholder is missing: ${reason.placeholder}.`
      case 'mismatchedInputBoundary': return `Input boundary placeholders are mismatched: ${reason.begin}, ${reason.end}.`
      case 'residualPlaceholders': return `Reconstruction left protected placeholders unresolved: ${reason.placeholders.join(', ')}.`
      case 'mainFileOutsideProject': return `The parsed main file is outside the prepared project: ${reason.path}.`
    }
  }
}

/** Copies every directory and regular file; symbolic links are rejected. */
export class NodeTranslationProjectCopier implements TranslationProjectCopying {
  async copyProject(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const visit = async (directory: string, relative: string[]): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        checkCancellation(signal)
        const path = join(directory, entry.name)
        const relativePath = [...relative, entry.name]
        const target = join(destination, ...relativePath)
        if (entry.isSymbolicLink()) throw new ReconstructionError({ kind: 'symbolicLinkNotSupported', path: relativePath.join('/') })
        if (entry.isDirectory()) {
          await mkdir(target, { recursive: true })
          await visit(path, relativePath)
        } else if (entry.isFile()) {
          await mkdir(join(target, '..'), { recursive: true })
          await copyFile(path, target)
        }
      }
    }
    await visit(source, [])
  }
}

// MARK: Reconstruction

export class StructuredLaTeXReconstructor implements LaTeXProjectReconstructing {
  private readonly copier: TranslationProjectCopying
  private readonly preamblePolicy: LaTeXPreambleTransforming

  constructor(options: { copier?: TranslationProjectCopying; preamblePolicy?: LaTeXPreambleTransforming } = {}) {
    this.copier = options.copier ?? new NodeTranslationProjectCopier()
    this.preamblePolicy = options.preamblePolicy ?? new ReferenceLanguagePreamblePolicy()
  }

  async reconstruct(project: PreparedProject, parsedProject: ParsedLaTeXProject, translatedUnits: TranslatedLaTeXUnit[], configuration: TranslationConfiguration, signal?: AbortSignal): Promise<string> {
    checkCancellation(signal)
    const expectedIDs = new Set(parsedProject.units.map((unit) => unit.id))
    const receivedIDs = new Set(translatedUnits.map((unit) => unit.id))
    if (expectedIDs.size !== receivedIDs.size || ![...expectedIDs].every((id) => receivedIDs.has(id)) || receivedIDs.size !== translatedUnits.length) {
      throw new ReconstructionError({ kind: 'invalidTranslationSet', expected: sortedStrings(expectedIDs), received: sortedStrings(translatedUnits.map((unit) => unit.id)) })
    }
    const translatedByID = new Map(translatedUnits.map((unit) => [unit.id, unit]))
    const destination = await makeDestination(project, configuration.targetLanguage)

    try {
      await this.copier.copyProject(project.sourceDirectory, destination, signal)
      checkCancellation(signal)
      let source = mergeSections(parsedProject.sections, translatedByID)
      source = restorePlaceholders(parsedProject.environments, 'environment', translatedByID, source)
      source = restorePlaceholders(parsedProject.captions, 'caption', translatedByID, source)
      source = restoreNewCommands(parsedProject.newCommands, source)
      source = await restoreInputs(parsedProject.inputs, source, destination)
      source = this.preamblePolicy.transform(source, configuration.targetLanguage)
      rejectResidualPlaceholders(source)

      const mainRelativePath = relativeMainFilePath(parsedProject.mainFile, project.sourceDirectory)
      await atomicWriteFile(safeOutputPath(mainRelativePath, destination), source)
      return destination
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}

function translationFor(id: string, translations: Map<string, TranslatedLaTeXUnit>): TranslatedLaTeXUnit {
  const translation = translations.get(id)
  if (!translation) throw new ReconstructionError({ kind: 'invalidTranslationSet', expected: [id], received: sortedStrings(translations.keys()) })
  return translation
}

function mergeSections(sections: LaTeXSection[], translations: Map<string, TranslatedLaTeXUnit>): string {
  return sections.map((section) => `${normalizeTranslationBoundary(translationFor(`section:${section.section}`, translations).translation)}\n`).join('')
}

function restorePlaceholders(items: Array<LaTeXEnvironment | LaTeXCaption>, kind: 'environment' | 'caption', translations: Map<string, TranslatedLaTeXUnit>, source: string): string {
  let result = source
  for (const item of items) {
    if (!result.includes(item.placeholder)) throw new ReconstructionError({ kind: 'missingPlaceholder', placeholder: item.placeholder })
    const translation = translationFor(`${kind}:${item.placeholder}`, translations)
    result = result.split(item.placeholder).join(normalizeTranslationBoundary(translation.translation))
  }
  return result
}

function restoreNewCommands(commands: LaTeXNewCommand[], source: string): string {
  let result = source
  for (const command of commands) {
    if (!result.includes(command.placeholder)) throw new ReconstructionError({ kind: 'missingPlaceholder', placeholder: command.placeholder })
    result = result.split(command.placeholder).join(command.content)
  }
  return result
}

/** Writes each input's text to its own file, innermost first, and puts the input command back. */
async function restoreInputs(inputs: LaTeXInputBoundary[], source: string, destination: string): Promise<string> {
  let result = source
  for (const input of [...inputs].reverse()) {
    let restoredAtLeastOnce = false
    for (let beginIndex = result.indexOf(input.begin); beginIndex >= 0; beginIndex = result.indexOf(input.begin)) {
      const innerStart = beginIndex + input.begin.length
      const endIndex = result.indexOf(input.end, innerStart)
      if (endIndex < 0) throw new ReconstructionError({ kind: 'mismatchedInputBoundary', begin: input.begin, end: input.end })
      const inner = trimmed(result.slice(innerStart, endIndex))
      const outputPath = input.path.endsWith('.tex') ? input.path : `${input.path}.tex`
      await atomicWriteFile(safeOutputPath(outputPath, destination), `${inner}\n`)
      result = result.slice(0, beginIndex) + input.command + result.slice(endIndex + input.end.length)
      restoredAtLeastOnce = true
    }
    if (!restoredAtLeastOnce && result.includes(input.end)) {
      throw new ReconstructionError({ kind: 'mismatchedInputBoundary', begin: input.begin, end: input.end })
    }
  }
  return result
}

function rejectResidualPlaceholders(source: string): void {
  const matches = source.match(/<PLACEHOLDER_[^>]+>/g)
  if (matches?.length) throw new ReconstructionError({ kind: 'residualPlaceholders', placeholders: sortedStrings(new Set(matches)) })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function makeDestination(project: PreparedProject, targetLanguage: TranslationLanguage): Promise<string> {
  const parent = join(project.workspaceDirectory, 'translated')
  const sourcePath = resolvedPath(project.sourceDirectory)
  const parentPath = resolvedPath(parent)
  if (parentPath === sourcePath || parentPath.startsWith(sourcePath + sep)) {
    throw new ReconstructionError({ kind: 'outputDirectoryInsideSource', path: parent })
  }
  await mkdir(parent, { recursive: true })
  const baseName = safeComponent(`${project.identifier}-${targetLanguage}`, '-_.', 'translated-project')
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(parent, suffix === 0 ? baseName : `${baseName}_${suffix}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

function relativeMainFilePath(mainFile: string, sourceDirectory: string): string {
  const root = resolvedPath(sourceDirectory)
  const main = resolvedPath(mainFile)
  if (!main.startsWith(root + sep)) throw new ReconstructionError({ kind: 'mainFileOutsideProject', path: mainFile })
  return main.slice(root.length + 1).split(sep).join('/')
}

/** A project-relative path below `destination`; absolute, drive-qualified and parent paths are rejected. */
export function safeOutputPath(path: string, destination: string): string {
  const components = path.replaceAll('\\', '/').split('/').filter(Boolean)
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.startsWith('~')
    || components.includes('.') || components.includes('..') || components[0]?.includes(':')) {
    throw new ReconstructionError({ kind: 'unsafeOutputPath', path })
  }
  const output = join(destination, ...components)
  const root = resolvedPath(destination)
  if (!resolvedPath(output).startsWith(root + sep)) throw new ReconstructionError({ kind: 'unsafeOutputPath', path })
  return output
}
