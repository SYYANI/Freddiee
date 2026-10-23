// Parsing/StructuredLaTeXParser.swift
import { readdir, readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DecodingError, decodeUTF8, isJSONObject, parseJSON } from './json'
import {
  LaTeXParserError, checkCancellation,
  type LaTeXCaption, type LaTeXEnvironment, type LaTeXInputBoundary, type LaTeXNewCommand, type LaTeXProjectParsing,
  type LaTeXSection, type LaTeXUnit, type ParsedLaTeXProject, type PreparedProject
} from './models'
import {
  characters, compareStrings, isASCIILetter, isLetter, isNewline, isNumber, isWhitespace, newlineComponents, slice, trimmed,
  type Characters
} from './text'

export interface LaTeXParserFileSystem {
  texFiles(directory: string): Promise<string[]>
  fileExists(path: string): Promise<boolean>
  readUTF8File(path: string): Promise<string>
  resolvedPath(path: string): string
}

/** Windows-1252 from 0x80 to 0x9F; NUL marks the five undefined bytes. */
const windows1252 = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ'

/**
 * Windows-1252 as Foundation decodes it: an undefined byte fails the whole file, which is
 * then read as Latin-1. (Node's TextDecoder reads "windows-1252" as Latin-1.)
 */
function decodeWindows1252(data: Uint8Array): string | undefined {
  let text = ''
  for (const byte of data) {
    if (byte < 0x80 || byte >= 0xa0) text += String.fromCharCode(byte)
    else if (windows1252[byte - 0x80] === '\0') return undefined
    else text += windows1252[byte - 0x80]
  }
  return text
}

/** Decodes a TeX file as UTF-8, then Windows-1252, then Latin-1, without a byte order mark. */
export function decodeTeXSource(data: Uint8Array): string {
  const text = decodeUTF8(data) ?? decodeWindows1252(data) ?? Array.from(data, (byte) => String.fromCharCode(byte)).join('')
  // U+FEFF is a control for grapheme breaking, so it is always a character of its own.
  return text.startsWith('\ufeff') ? text.slice(1) : text
}

/**
 * The absolute path with symbolic links resolved in every existing component, as
 * `standardizedFileURL.resolvingSymlinksInPath()` does; components that do not exist yet are
 * appended unchanged. (Without this, `/var` against `/private/var` on macOS, or a short 8.3
 * name against its long form on Windows, would put a new file outside its own folder.)
 */
export function resolvedPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(resolvedPath(parent), basename(absolute))
  }
}

export class NodeLaTeXParserFileSystem implements LaTeXParserFileSystem {
  async texFiles(directory: string): Promise<string[]> {
    const files: string[] = []
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        // Hidden files and folders are skipped; symbolic links are neither regular files nor descended into.
        if (entry.name.startsWith('.')) continue
        const path = join(folder, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tex') && entry.name.length > 4) files.push(path)
      }
    }
    try {
      await visit(directory)
    } catch {
      return files
    }
    return files
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      return !(await stat(path)).isDirectory()
    } catch {
      return false
    }
  }

  async readUTF8File(path: string): Promise<string> {
    return decodeTeXSource(new Uint8Array(await readFile(path)))
  }

  resolvedPath(path: string): string {
    return resolvedPath(path)
  }
}

export interface LaTeXTokenCounting {
  tokenCount(text: string): number
}

/** A deterministic approximation used only for the reference parser's short-section merge threshold. */
export class DeterministicLaTeXTokenCounter implements LaTeXTokenCounting {
  tokenCount(text: string): number {
    const chars = characters(text)
    let count = 0
    let index = 0
    const isWord = (character: string): boolean => isLetter(character) || isNumber(character) || character === '_'
    while (index < chars.length) {
      if (isWhitespace(chars[index])) {
        index += 1
      } else if (chars[index] === '<' && index + 13 < chars.length && slice(chars, index, Math.min(index + 13, chars.length)).startsWith('<PLACEHOLDER_')) {
        count += 1
        index += 1
        while (index < chars.length && chars[index] !== '>') index += 1
        if (index < chars.length) index += 1
      } else if (chars[index] === '\\') {
        count += 1
        index += 1
        while (index < chars.length && isLetter(chars[index])) index += 1
        if (index < chars.length && chars[index] === '*') index += 1
      } else if (isWord(chars[index])) {
        count += 1
        index += 1
        while (index < chars.length && isWord(chars[index])) index += 1
      } else {
        count += 1
        index += 1
      }
    }
    return count
  }
}

export interface StructuredLaTeXParserLimits {
  maximumIncludeDepth: number
  maximumIncludedFileCount: number
  maximumSourceCharacters: number
}

export function parserLimits(limits: Partial<StructuredLaTeXParserLimits> = {}): StructuredLaTeXParserLimits {
  return {
    maximumIncludeDepth: Math.max(1, limits.maximumIncludeDepth ?? 32),
    maximumIncludedFileCount: Math.max(1, limits.maximumIncludedFileCount ?? 512),
    maximumSourceCharacters: Math.max(1, limits.maximumSourceCharacters ?? 8_000_000)
  }
}

interface CommandMatch { name: string; argument: string; start: number; end: number }
interface IncludeMatch { name: string; argument: string; directoryArgument?: string; fileArgument: string; start: number; end: number }
interface RangeMatch { name: string; start: number; end: number }

export class StructuredLaTeXParser implements LaTeXProjectParsing {
  private readonly fileSystem: LaTeXParserFileSystem
  private readonly tokenCounter: LaTeXTokenCounting
  private readonly minimumSectionTokenCount: number
  private readonly limits: StructuredLaTeXParserLimits

  constructor(options: {
    fileSystem?: LaTeXParserFileSystem
    tokenCounter?: LaTeXTokenCounting
    minimumSectionTokenCount?: number
    limits?: Partial<StructuredLaTeXParserLimits>
  } = {}) {
    this.fileSystem = options.fileSystem ?? new NodeLaTeXParserFileSystem()
    this.tokenCounter = options.tokenCounter ?? new DeterministicLaTeXTokenCounter()
    this.minimumSectionTokenCount = Math.max(0, options.minimumSectionTokenCount ?? 50)
    this.limits = parserLimits(options.limits)
  }

  async parse(project: PreparedProject, signal?: AbortSignal): Promise<ParsedLaTeXProject> {
    checkCancellation(signal)
    const projectRoot = this.fileSystem.resolvedPath(project.sourceDirectory)
    const mainFile = await this.findMainFile(projectRoot)
    const mainText = await this.fileSystem.readUTF8File(mainFile)
    if (!mainText) throw new LaTeXParserError({ kind: 'emptyMainFile', path: mainFile })
    if (characters(mainText).length > this.limits.maximumSourceCharacters) {
      throw new LaTeXParserError({ kind: 'sourceCharacterLimitExceeded', limit: this.limits.maximumSourceCharacters })
    }

    const inputs: LaTeXInputBoundary[] = []
    const includedFileCount = { value: 1 }
    const mainRelativePath = this.relativePath(mainFile, projectRoot)
    const uncommented = removeComments(mainText)
    let expanded = await this.expandInputs(uncommented, projectRoot, dirname(mainFile), [mainRelativePath], inputs, includedFileCount, signal)

    checkCancellation(signal)
    const newCommands: LaTeXNewCommand[] = []
    expanded = extractNewCommands(expanded, newCommands)
    expanded = compressNewlines(expanded)

    const sections = this.mergeShortSections(splitIntoSections(expanded))

    const captions: LaTeXCaption[] = []
    const environments: LaTeXEnvironment[] = []
    const captionCount = { value: 0 }
    const environmentCount = { value: 0 }
    const processedSections: LaTeXSection[] = []
    for (const section of sections) {
      checkCancellation(signal)
      let content = extractCaptions(section.content, captionCount, captions)
      content = extractEnvironments(content, environmentCount, environments)
      const translatedContent = section.section === '-1' || section.section === '0' ? content : section.trans_content
      processedSections.push({ section: section.section, content, trans_content: translatedContent })
    }

    const sectionUnits = processedSections.map((section): LaTeXUnit => ({
      id: `section:${section.section}`,
      kind: 'section',
      source: section.content,
      shouldTranslate: section.section !== '-1' && section.section !== '0'
    }))
    const captionUnits = captions.map((caption): LaTeXUnit => ({ id: `caption:${caption.placeholder}`, kind: 'caption', source: caption.content, shouldTranslate: true }))
    const environmentUnits = environments.map((environment): LaTeXUnit => ({
      id: `environment:${environment.placeholder}`,
      kind: 'environment',
      source: environment.content,
      shouldTranslate: environment.need_trans
    }))

    return {
      mainFile,
      units: [...sectionUnits, ...captionUnits, ...environmentUnits],
      inputs,
      environments,
      captions,
      newCommands,
      sections: processedSections
    }
  }

  private async findMainFile(projectRoot: string): Promise<string> {
    const readme = join(projectRoot, '00README.json')
    if (await this.fileSystem.fileExists(readme)) {
      const metadata = parseJSON(await this.fileSystem.readUTF8File(readme))
      const sources = isJSONObject(metadata) ? metadata.sources : undefined
      const valid = Array.isArray(sources) && sources.every((source) => isJSONObject(source)
        && typeof source.filename === 'string'
        && (source.usage === undefined || source.usage === null || typeof source.usage === 'string'))
      if (!valid) throw new DecodingError()
      const path = (sources as Array<{ filename: string; usage?: string | null }>).find((source) => source.usage === 'toplevel')?.filename
      if (path !== undefined) {
        const candidate = this.safeProjectPath(path, projectRoot, projectRoot, path)
        if (!(await this.fileSystem.fileExists(candidate))) throw new LaTeXParserError({ kind: 'mainFileNotFound', projectDirectory: projectRoot })
        return candidate
      }
    }

    const files = (await this.fileSystem.texFiles(projectRoot))
      .sort((a, b) => compareStrings(this.relativePath(a, projectRoot), this.relativePath(b, projectRoot)))
    for (const file of files) {
      const resolved = this.fileSystem.resolvedPath(file)
      if (!this.isWithinProject(resolved, projectRoot)) throw new LaTeXParserError({ kind: 'unsafePath', path: this.relativePath(file, projectRoot) })
      const text = removeComments(await this.fileSystem.readUTF8File(resolved))
      if (firstCommand(characters(text), new Set(['documentclass', 'documentstyle']), 0)) return resolved
    }
    throw new LaTeXParserError({ kind: 'mainFileNotFound', projectDirectory: projectRoot })
  }

  private async expandInputs(
    text: string,
    projectRoot: string,
    currentFileDirectory: string,
    includeStack: string[],
    inputs: LaTeXInputBoundary[],
    includedFileCount: { value: number },
    signal?: AbortSignal
  ): Promise<string> {
    const limit = this.limits.maximumSourceCharacters
    const characterLimit = (): LaTeXParserError => new LaTeXParserError({ kind: 'sourceCharacterLimitExceeded', limit })
    if (includeStack.length > this.limits.maximumIncludeDepth) {
      throw new LaTeXParserError({ kind: 'includeDepthExceeded', limit: this.limits.maximumIncludeDepth })
    }
    if (characters(text).length > limit) throw characterLimit()
    const chars = characters(removeComments(text))
    // Joined pieces, with their total length in characters.
    const output: string[] = []
    let outputCount = 0
    let cursor = 0

    for (let match = firstInclude(chars, cursor); match; match = firstInclude(chars, cursor)) {
      checkCancellation(signal)
      output.push(slice(chars, cursor, match.start))
      outputCount += match.start - cursor
      const requestedPath = match.argument
      let includeBaseDirectory: string
      if (match.name === 'import') includeBaseDirectory = this.resolveDirectory(match.directoryArgument ?? '', projectRoot, projectRoot)
      else if (match.name === 'subimport') includeBaseDirectory = this.resolveDirectory(match.directoryArgument ?? '', currentFileDirectory, projectRoot)
      else includeBaseDirectory = projectRoot
      const includeFile = await this.resolveInclude(match.fileArgument, includeBaseDirectory, projectRoot, requestedPath)
      const includeRelativePath = this.relativePath(includeFile, projectRoot)
      if (includeStack.includes(includeRelativePath)) {
        throw new LaTeXParserError({ kind: 'recursiveInclude', chain: [...includeStack, includeRelativePath] })
      }
      includedFileCount.value += 1
      if (includedFileCount.value > this.limits.maximumIncludedFileCount) {
        throw new LaTeXParserError({ kind: 'includedFileCountExceeded', limit: this.limits.maximumIncludedFileCount })
      }

      const beginPlaceholder = `<PLACEHOLDER_${requestedPath}_begin>`
      const endPlaceholder = `<PLACEHOLDER_${requestedPath}_end>`
      inputs.push({ command: slice(chars, match.start, match.end), begin: beginPlaceholder, end: endPlaceholder, path: requestedPath })

      const includedText = await this.fileSystem.readUTF8File(includeFile)
      const nested = await this.expandInputs(includedText, projectRoot, dirname(includeFile), [...includeStack, includeRelativePath], inputs, includedFileCount, signal)
      for (const part of [beginPlaceholder, nested, endPlaceholder]) {
        output.push(part)
        outputCount += characters(part).length
      }
      if (outputCount > limit) throw characterLimit()
      cursor = match.end
    }
    output.push(slice(chars, cursor))
    outputCount += chars.length - cursor
    if (outputCount > limit) throw characterLimit()
    return output.join('')
  }

  private async resolveInclude(path: string, baseDirectory: string, projectRoot: string, reportedPath: string): Promise<string> {
    const baseCandidate = this.safeProjectPath(path, baseDirectory, projectRoot, reportedPath)
    if (await this.fileSystem.fileExists(baseCandidate)) return baseCandidate
    const texCandidate = this.safeProjectPath(`${path}.tex`, baseDirectory, projectRoot, reportedPath)
    if (await this.fileSystem.fileExists(texCandidate)) return texCandidate
    throw new LaTeXParserError({ kind: 'includeNotFound', path: reportedPath })
  }

  private resolveDirectory(path: string, baseDirectory: string, projectRoot: string): string {
    if (!path) return baseDirectory
    return this.safeProjectPath(path, baseDirectory, projectRoot, path)
  }

  private safeProjectPath(path: string, baseDirectory: string, projectRoot: string, reportedPath: string): string {
    if (!path || path.startsWith('/') || path.startsWith('~')) throw new LaTeXParserError({ kind: 'unsafePath', path: reportedPath })
    const candidate = this.fileSystem.resolvedPath(join(baseDirectory, path))
    if (!this.isWithinProject(candidate, projectRoot)) throw new LaTeXParserError({ kind: 'unsafePath', path: reportedPath })
    return candidate
  }

  private isWithinProject(path: string, projectRoot: string): boolean {
    const rootPath = this.fileSystem.resolvedPath(projectRoot)
    const targetPath = this.fileSystem.resolvedPath(path)
    return targetPath === rootPath || targetPath.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep)
  }

  /** Project-relative with "/" separators on every platform; outside paths stay absolute. */
  private relativePath(path: string, projectRoot: string): string {
    const rootPath = this.fileSystem.resolvedPath(projectRoot)
    const targetPath = this.fileSystem.resolvedPath(path)
    const prefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep
    if (!targetPath.startsWith(prefix)) return targetPath
    return targetPath.slice(prefix.length).split(sep).join('/')
  }

  private mergeShortSections(sections: LaTeXSection[]): LaTeXSection[] {
    if (this.minimumSectionTokenCount <= 0) return sections
    const merged: LaTeXSection[] = []
    let index = 0
    while (index < sections.length) {
      const start = sections[index]
      let content = start.content
      const identifiers = [start.section]
      let tokenCount = this.tokenCounter.tokenCount(content)
      let next = index + 1
      while (tokenCount < this.minimumSectionTokenCount && next < sections.length) {
        content += `\n${sections[next].content}`
        identifiers.push(sections[next].section)
        tokenCount = this.tokenCounter.tokenCount(content)
        next += 1
      }
      if (tokenCount < this.minimumSectionTokenCount && merged.length) {
        const previous = merged.pop()!
        merged.push({ section: `${previous.section}+${identifiers.join('+')}`, content: `${previous.content}\n${content}`, trans_content: previous.trans_content })
      } else {
        merged.push({ section: identifiers.join('+'), content, trans_content: start.trans_content })
      }
      index = next
    }
    return merged
  }
}

// MARK: Text operations

export const protectedEnvironmentNames: ReadonlySet<string> = new Set([
  'equation', 'align', 'align*', 'gather', 'gather*', 'verbatim', 'verbatim*',
  'lstlisting*', 'minted', 'minted*', 'equation*', 'alignat', 'alignat*',
  'flalign', 'flalign*', 'split', 'split*', 'cases', 'cases*', 'subequations',
  'figure', 'figure*', 'wrapfigure', 'SCfigure', 'tikzpicture', 'CJK', 'scope',
  'tabularx', 'tabulary', 'longtable*', 'sidewaystable', 'table', 'table*',
  'tabular', 'tabular*', 'longtable', 'multline', 'multline*', 'lstlisting',
  'tcolorbox', 'thebibliography', 'bibliography', 'bibitem', 'algorithm',
  'algorithmic', 'algorithmicx', 'algorithm2e', 'algorithmicx*', 'algorithmic*',
  'algorithm*'
])

/** Removes `comment` environments, whole-line comments and trailing comments, then trailing whitespace. */
export function removeComments(text: string): string {
  const chars = characters(text)
  const uncommented: string[] = []
  let cursor = 0
  for (let begin = firstCommentCommand('begin', chars, cursor); begin; begin = firstCommentCommand('begin', chars, cursor)) {
    const end = firstCommentCommand('end', chars, begin.end)
    if (!end) break
    for (let index = cursor; index < begin.start; index += 1) uncommented.push(chars[index])
    cursor = end.end
  }
  for (let index = cursor; index < chars.length; index += 1) uncommented.push(chars[index])
  const withoutBlocks = uncommented.join('')

  const lines = newlineComponents(withoutBlocks)
  // The last character is a newline exactly when the last scalar is one: newlines end their cluster.
  if (withoutBlocks && isNewline(withoutBlocks.slice(-1)) && lines[lines.length - 1] === '') lines.pop()
  const cleaned: string[] = []
  for (const line of lines) {
    const lineCharacters = characters(line)
    const firstNonWhitespace = lineCharacters.find((character) => !isWhitespace(character))
    if (firstNonWhitespace === '%') continue
    let end = lineCharacters.length
    for (let index = 0; index < lineCharacters.length; index += 1) {
      if (lineCharacters[index] !== '%') continue
      if (index === 0 || lineCharacters[index - 1] !== '\\') {
        end = index
        break
      }
    }
    while (end > 0 && isWhitespace(lineCharacters[end - 1])) end -= 1
    cleaned.push(slice(lineCharacters, 0, end))
  }
  return cleaned.join('\n')
}

function firstCommentCommand(name: string, chars: Characters, start: number): CommandMatch | undefined {
  let index = start
  while (index < chars.length) {
    const parsedName = chars[index] === '\\' ? parseCommandName(chars, index) : undefined
    if (!parsedName || parsedName.name !== name) {
      index += 1
      continue
    }
    let cursor = parsedName.end
    while (cursor < chars.length && isWhitespace(chars[cursor])) cursor += 1
    const argument = cursor < chars.length && chars[cursor] === '{' ? balancedGroup(chars, cursor, '{', '}') : undefined
    if (!argument) {
      index = parsedName.end
      continue
    }
    if (trimmed(slice(chars, argument.innerStart, argument.innerEnd)) === 'comment') {
      return { name: parsedName.name, argument: 'comment', start: index, end: argument.end }
    }
    index = argument.end
  }
  return undefined
}

/** Keeps at most two consecutive newlines, dropping the whitespace between them. */
export function compressNewlines(text: string): string {
  let output = ''
  let pendingWhitespace = ''
  let newlineCount = 0
  for (const character of characters(text)) {
    if (character === '\n') {
      newlineCount += 1
      pendingWhitespace = ''
      if (newlineCount <= 2) output += character
    } else if (isWhitespace(character) && newlineCount > 0) {
      pendingWhitespace += character
    } else {
      if (newlineCount > 0 && newlineCount <= 2) output += pendingWhitespace
      newlineCount = 0
      pendingWhitespace = ''
      output += character
    }
  }
  return output
}

/**
 * Swift rebuilds the string and splits it again after each replacement; splicing the
 * character array is equivalent, provided clusters that merge across a seam are joined.
 */
function replacing(chars: Characters, start: number, end: number, replacement: string): Characters {
  const inserted = characters(replacement)
  const result = chars.slice(0, start).concat(inserted, chars.slice(end))
  const joinSeam = (seam: number): void => {
    if (seam <= 0 || seam >= result.length) return
    const combined = characters(result[seam - 1] + result[seam])
    if (combined.length === 1) result.splice(seam - 1, 2, combined[0])
  }
  joinSeam(start + inserted.length)
  joinSeam(start)
  return result
}

export function extractNewCommands(text: string, commands: LaTeXNewCommand[]): string {
  let content = characters(removeComments(text))
  for (let match = firstNewCommand(content); match; match = firstNewCommand(content)) {
    const placeholder = `<PLACEHOLDER_NEWCOMMAND_${commands.length}>`
    commands.push({ placeholder, name: match.name, content: slice(content, match.start, match.end) })
    content = replacing(content, match.start, match.end, placeholder)
  }
  return content.join('')
}

const sectionCommandNames = new Set(['section', 'section*', 'subsection', 'subsection*', 'subsubsection', 'subsubsection*'])

export function splitIntoSections(text: string): LaTeXSection[] {
  const chars = characters(removeComments(text))
  const beginDocument = allCommands(chars, new Set(['begin'])).find((match) => trimmed(match.argument) === 'document')
  const documentStart = beginDocument?.start ?? 0
  const preambleEnd = beginDocument?.start ?? chars.length
  const preamble = slice(chars, 0, preambleEnd)
  const document = chars.slice(documentStart)
  const sections: LaTeXSection[] = [{ section: '-1', content: preamble, trans_content: preamble }]

  const sectionMatches = allCommands(document, sectionCommandNames)
  const firstSection = sectionMatches[0]
  if (!firstSection) {
    sections.push({ section: '0', content: document.join(''), trans_content: '' })
    return sections
  }
  const front = slice(document, 0, firstSection.start)
  sections.push({ section: '0', content: front, trans_content: front })

  let sectionCount = 0
  let subsectionCount = 0
  let subsubsectionCount = 0
  sectionMatches.forEach((match, index) => {
    const end = index + 1 < sectionMatches.length ? sectionMatches[index + 1].start : document.length
    let identifier: string
    if (match.name === 'section' || match.name === 'section*') {
      sectionCount += 1
      subsectionCount = 0
      subsubsectionCount = 0
      identifier = `${sectionCount}`
    } else if (match.name === 'subsection' || match.name === 'subsection*') {
      subsectionCount += 1
      subsubsectionCount = 0
      identifier = `${sectionCount}_${subsectionCount}`
    } else {
      subsubsectionCount += 1
      identifier = `${sectionCount}_${subsectionCount}_${subsubsectionCount}`
    }
    sections.push({ section: identifier, content: slice(document, match.start, end), trans_content: '' })
  })
  return sections
}

const captionCommandNames = new Set(['caption', 'caption*', 'subcaption', 'subcaption*', 'title', 'keywords', 'abstract', 'icmltitle', 'icmltitlerunning'])

export function extractCaptions(text: string, count: { value: number }, captions: LaTeXCaption[]): string {
  let content = characters(removeComments(text))
  for (let match = firstCommand(content, captionCommandNames, 0); match; match = firstCommand(content, captionCommandNames, 0)) {
    count.value += 1
    const placeholder = `<PLACEHOLDER_CAP_${count.value}>`
    captions.push({ placeholder, cap_type: match.name, content: slice(content, match.start, match.end), trans_content: '' })
    content = replacing(content, match.start, match.end, placeholder)
  }
  return content.join('')
}

export function extractEnvironments(text: string, count: { value: number }, environments: LaTeXEnvironment[]): string {
  let content = characters(removeComments(text))
  for (let match = firstEnvironment(content); match; match = firstEnvironment(content)) {
    count.value += 1
    const placeholder = `<PLACEHOLDER_ENV_${count.value}>`
    const environmentContent = slice(content, match.start, match.end)
    // NSRegularExpression's \d matches every decimal digit.
    const hasCaption = /<PLACEHOLDER_CAP_\p{Nd}+>/u.test(environmentContent)
    environments.push({
      placeholder,
      env_name: match.name,
      content: environmentContent,
      trans_content: '',
      need_trans: !protectedEnvironmentNames.has(match.name) && !hasCaption
    })
    content = replacing(content, match.start, match.end, placeholder)
  }
  return content.join('')
}

const excludedEnvironmentNames = new Set(['document', 'center', 'proof', 'multicols'])
const beginName = new Set(['begin'])
const boundaryNames = new Set(['begin', 'end'])

function firstEnvironment(chars: Characters): RangeMatch | undefined {
  let cursor = 0
  for (let begin = firstCommand(chars, beginName, cursor); begin; begin = firstCommand(chars, beginName, cursor)) {
    const environmentName = begin.argument
    cursor = begin.end
    if (excludedEnvironmentNames.has(environmentName)) continue
    let depth = 1
    let endCursor = begin.end
    for (let command = firstCommand(chars, boundaryNames, endCursor); command; command = firstCommand(chars, boundaryNames, endCursor)) {
      if (command.argument === environmentName) {
        depth += command.name === 'begin' ? 1 : -1
        if (depth === 0) return { name: environmentName, start: begin.start, end: command.end }
      }
      endCursor = command.end
    }
  }
  return undefined
}

const newCommandNames = new Set(['newcommand', 'newcommand*', 'def', 'renewcommand', 'newenvironment', 'renewenvironment'])

function firstNewCommand(chars: Characters): RangeMatch | undefined {
  let index = 0
  while (index < chars.length) {
    const parsedName = chars[index] === '\\' ? parseCommandName(chars, index) : undefined
    if (!parsedName || !newCommandNames.has(parsedName.name)) {
      index += 1
      continue
    }
    let cursor = skipHorizontalWhitespace(chars, parsedName.end)
    let commandName: string
    if (cursor < chars.length && chars[cursor] === '{') {
      const group = balancedGroup(chars, cursor, '{', '}')
      if (!group) {
        index = parsedName.end
        continue
      }
      const rawName = chars.slice(group.innerStart, group.innerEnd)
      if (rawName[0] !== '\\' || !rawName.slice(1).every(isASCIILetter)) {
        index = parsedName.end
        continue
      }
      commandName = rawName.slice(1).join('')
      cursor = group.end
    } else {
      const macroName = cursor < chars.length && chars[cursor] === '\\' ? parseCommandName(chars, cursor) : undefined
      if (!macroName) {
        index = parsedName.end
        continue
      }
      commandName = macroName.name.replaceAll('*', '')
      cursor = macroName.end
    }
    cursor = skipHorizontalWhitespace(chars, cursor)
    if (cursor < chars.length && chars[cursor] === '[') {
      const argumentsGroup = balancedGroup(chars, cursor, '[', ']')
      if (argumentsGroup) cursor = argumentsGroup.end
    }
    cursor = skipHorizontalWhitespace(chars, cursor)
    const body = cursor < chars.length && chars[cursor] === '{' ? balancedGroup(chars, cursor, '{', '}') : undefined
    if (!body) {
      index = parsedName.end
      continue
    }
    return { name: commandName, start: index, end: body.end }
  }
  return undefined
}

/** The first `\name[options]{argument}` with a name in `names`, at or after `start`. */
export function firstCommand(chars: Characters, names: ReadonlySet<string>, start: number): CommandMatch | undefined {
  let index = start
  while (index < chars.length) {
    const parsedName = chars[index] === '\\' ? parseCommandName(chars, index) : undefined
    if (!parsedName || !names.has(parsedName.name)) {
      index += 1
      continue
    }
    let cursor = skipHorizontalWhitespace(chars, parsedName.end)
    if (cursor < chars.length && chars[cursor] === '[') {
      const options = balancedGroup(chars, cursor, '[', ']')
      if (options) cursor = skipHorizontalWhitespace(chars, options.end)
    }
    const argument = cursor < chars.length && chars[cursor] === '{' ? balancedGroup(chars, cursor, '{', '}') : undefined
    if (!argument) {
      index = parsedName.end
      continue
    }
    return { name: parsedName.name, argument: slice(chars, argument.innerStart, argument.innerEnd), start: index, end: argument.end }
  }
  return undefined
}

const includeNames = new Set(['input', 'include', 'subfile', 'import', 'subimport'])

function firstInclude(chars: Characters, start: number): IncludeMatch | undefined {
  let index = start
  while (index < chars.length) {
    const parsedName = chars[index] === '\\' ? parseCommandName(chars, index) : undefined
    if (!parsedName || !includeNames.has(parsedName.name)) {
      index += 1
      continue
    }
    let cursor = skipHorizontalWhitespace(chars, parsedName.end)
    const first = cursor < chars.length && chars[cursor] === '{' ? balancedGroup(chars, cursor, '{', '}') : undefined
    if (!first) {
      index = parsedName.end
      continue
    }
    const firstArgument = slice(chars, first.innerStart, first.innerEnd)
    let path = firstArgument
    let directoryArgument: string | undefined
    let fileArgument = firstArgument
    cursor = first.end
    if (parsedName.name === 'import' || parsedName.name === 'subimport') {
      cursor = skipHorizontalWhitespace(chars, cursor)
      const second = cursor < chars.length && chars[cursor] === '{' ? balancedGroup(chars, cursor, '{', '}') : undefined
      if (!second) {
        index = parsedName.end
        continue
      }
      directoryArgument = firstArgument
      fileArgument = slice(chars, second.innerStart, second.innerEnd)
      const directory = path.endsWith('/') || !path ? path : `${path}/`
      path = directory + fileArgument
      cursor = second.end
    }
    return { name: parsedName.name, argument: path, directoryArgument, fileArgument, start: index, end: cursor }
  }
  return undefined
}

function allCommands(chars: Characters, names: ReadonlySet<string>): CommandMatch[] {
  const matches: CommandMatch[] = []
  let cursor = 0
  for (let match = firstCommand(chars, names, cursor); match; match = firstCommand(chars, names, cursor)) {
    matches.push(match)
    cursor = match.end
  }
  return matches
}

function parseCommandName(chars: Characters, slashIndex: number): { name: string; end: number } | undefined {
  let cursor = slashIndex + 1
  const nameStart = cursor
  while (cursor < chars.length && isASCIILetter(chars[cursor])) cursor += 1
  if (cursor <= nameStart) return undefined
  let name = slice(chars, nameStart, cursor)
  if (cursor < chars.length && chars[cursor] === '*') {
    name += '*'
    cursor += 1
  }
  return { name, end: cursor }
}

function balancedGroup(chars: Characters, start: number, opening: string, closing: string): { innerStart: number; innerEnd: number; end: number } | undefined {
  if (start >= chars.length || chars[start] !== opening) return undefined
  let depth = 0
  for (let cursor = start; cursor < chars.length; cursor += 1) {
    if (chars[cursor] === opening) depth += 1
    else if (chars[cursor] === closing) {
      depth -= 1
      if (depth === 0) return { innerStart: start + 1, innerEnd: cursor, end: cursor + 1 }
    }
  }
  return undefined
}

function skipHorizontalWhitespace(chars: Characters, start: number): number {
  let cursor = start
  while (cursor < chars.length && (chars[cursor] === ' ' || chars[cursor] === '\t')) cursor += 1
  return cursor
}
