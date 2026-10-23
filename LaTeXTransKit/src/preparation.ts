// Preparation/SecureProjectPreparation.swift and LocalDirectoryProjectPreparer.swift
import { mkdir, rm, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { atomicWriteFile } from '../../electron/main/files'
import type { TranslationArchiveEntry, TranslationArchiveEntryKind, TranslationArchiveReading } from './archives'
import { resolvedPath } from './parser'
import {
  TranslationPipelineError, checkCancellation,
  type PreparedProject, type TranslationProjectPreparing, type TranslationProjectSource, type TranslationRequest
} from './models'
import { safeComponent } from './text'

export interface ArchiveExtractionLimits {
  maximumEntryCount: number
  maximumEntrySize: number
  maximumTotalSize: number
}

export function archiveExtractionLimits(limits: Partial<ArchiveExtractionLimits> = {}): ArchiveExtractionLimits {
  return {
    maximumEntryCount: Math.max(1, limits.maximumEntryCount ?? 10_000),
    maximumEntrySize: Math.max(0, limits.maximumEntrySize ?? 128 * 1_024 * 1_024),
    maximumTotalSize: Math.max(0, limits.maximumTotalSize ?? 512 * 1_024 * 1_024)
  }
}

export type ProjectPreparationErrorReason =
  | { kind: 'archiveNotFound'; path: string }
  | { kind: 'unsafeArchiveEntry'; path: string }
  | { kind: 'unsupportedArchiveEntry'; path: string; entryKind: TranslationArchiveEntryKind }
  | { kind: 'duplicateArchiveEntry'; path: string }
  | { kind: 'archiveLimitExceeded'; message: string }
  | { kind: 'invalidArchiveEntrySize'; path: string; declared: number; actual: number }
  | { kind: 'emptyArchive' }
  | { kind: 'invalidArXivIdentifier'; identifier: string }
  | { kind: 'unsupportedAcquiredSource' }

export class ProjectPreparationError extends Error {
  constructor(readonly reason: ProjectPreparationErrorReason) {
    super(ProjectPreparationError.describe(reason))
    this.name = 'ProjectPreparationError'
  }

  private static describe(reason: ProjectPreparationErrorReason): string {
    switch (reason.kind) {
      case 'archiveNotFound': return `The local archive does not exist: ${reason.path}.`
      case 'unsafeArchiveEntry': return `The archive contains an unsafe entry path: ${reason.path}.`
      case 'unsupportedArchiveEntry': return `The archive entry ${reason.path} has unsupported kind ${reason.entryKind}.`
      case 'duplicateArchiveEntry': return `The archive contains a duplicate entry path: ${reason.path}.`
      case 'archiveLimitExceeded': return `Archive extraction limit exceeded: ${reason.message}.`
      case 'invalidArchiveEntrySize': return `Archive entry ${reason.path} declared ${reason.declared} bytes but produced ${reason.actual} bytes.`
      case 'emptyArchive': return 'The archive contains no regular files.'
      case 'invalidArXivIdentifier': return `The arXiv identifier is invalid: ${reason.identifier}.`
      case 'unsupportedAcquiredSource': return 'The arXiv acquisition adapter returned an unsupported recursive source.'
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export class LocalDirectoryProjectPreparer implements TranslationProjectPreparing {
  async prepare(request: TranslationRequest): Promise<PreparedProject> {
    const { source } = request
    if (source.kind !== 'localDirectory') throw new TranslationPipelineError({ kind: 'unsupportedSource', source })
    if (!(await isDirectory(source.path))) {
      throw new TranslationPipelineError({ kind: 'invalidProject', message: `The local LaTeX project directory does not exist: ${source.path}` })
    }
    return { identifier: basename(source.path), sourceDirectory: source.path, workspaceDirectory: request.workspaceDirectory }
  }
}

/** Extracts an archive below `workspace/prepared`, enforcing path, link, duplicate, count and size limits. */
export class SecureArchiveProjectPreparer implements TranslationProjectPreparing {
  private readonly limits: ArchiveExtractionLimits

  constructor(private readonly reader: TranslationArchiveReading, limits: Partial<ArchiveExtractionLimits> = {}) {
    this.limits = archiveExtractionLimits(limits)
  }

  async prepare(request: TranslationRequest, signal?: AbortSignal): Promise<PreparedProject> {
    const { source } = request
    if (source.kind !== 'localArchive') throw new TranslationPipelineError({ kind: 'unsupportedSource', source })
    let isFile = false
    try {
      isFile = !(await stat(source.path)).isDirectory()
    } catch {
      // Reported below.
    }
    if (!isFile) throw new ProjectPreparationError({ kind: 'archiveNotFound', path: source.path })

    checkCancellation(signal)
    const destination = await makeUniqueDestination(source.path, request.workspaceDirectory)
    try {
      await this.extract(this.reader.entries(source.path, signal), destination, signal)
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return { identifier: archiveStem(basename(source.path)), sourceDirectory: destination, workspaceDirectory: request.workspaceDirectory }
  }

  private async extract(entries: AsyncIterable<TranslationArchiveEntry>, destination: string, signal?: AbortSignal): Promise<void> {
    const { limits } = this
    const seenPaths = new Set<string>()
    let entryCount = 0
    let totalSize = 0
    let regularFileCount = 0

    for await (const entry of entries) {
      checkCancellation(signal)
      entryCount += 1
      if (entryCount > limits.maximumEntryCount) {
        throw new ProjectPreparationError({ kind: 'archiveLimitExceeded', message: `more than ${limits.maximumEntryCount} entries` })
      }
      const components = validatedComponents(entry.path)
      const normalizedPath = components.join('/')
      if (seenPaths.has(normalizedPath)) throw new ProjectPreparationError({ kind: 'duplicateArchiveEntry', path: entry.path })
      seenPaths.add(normalizedPath)
      const target = join(destination, ...components)
      if (!isWithinDirectory(target, destination)) throw new ProjectPreparationError({ kind: 'unsafeArchiveEntry', path: entry.path })

      switch (entry.kind) {
        case 'directory':
          if (entry.uncompressedSize !== 0 || entry.contents.length) {
            throw new ProjectPreparationError({ kind: 'invalidArchiveEntrySize', path: entry.path, declared: entry.uncompressedSize, actual: entry.contents.length })
          }
          await mkdir(target, { recursive: true })
          break
        case 'regularFile': {
          const actualSize = entry.contents.length
          if (entry.uncompressedSize !== actualSize) {
            throw new ProjectPreparationError({ kind: 'invalidArchiveEntrySize', path: entry.path, declared: entry.uncompressedSize, actual: actualSize })
          }
          if (actualSize > limits.maximumEntrySize) {
            throw new ProjectPreparationError({ kind: 'archiveLimitExceeded', message: `entry ${entry.path} exceeds ${limits.maximumEntrySize} bytes` })
          }
          const newTotal = totalSize + actualSize
          if (newTotal > limits.maximumTotalSize) {
            throw new ProjectPreparationError({ kind: 'archiveLimitExceeded', message: `expanded data exceeds ${limits.maximumTotalSize} bytes` })
          }
          totalSize = newTotal
          await atomicWriteFile(target, entry.contents)
          regularFileCount += 1
          break
        }
        case 'symbolicLink':
        case 'hardLink':
          throw new ProjectPreparationError({ kind: 'unsupportedArchiveEntry', path: entry.path, entryKind: entry.kind })
      }
    }
    if (regularFileCount === 0) throw new ProjectPreparationError({ kind: 'emptyArchive' })
  }
}

function validatedComponents(path: string): string[] {
  const unsafe = (): ProjectPreparationError => new ProjectPreparationError({ kind: 'unsafeArchiveEntry', path })
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.startsWith('~') || path.includes('\0')) throw unsafe()
  const components = path.replaceAll('\\', '/').split('/').filter(Boolean)
  if (!components.length || components.includes('.') || components.includes('..') || components[0].includes(':')) throw unsafe()
  return components
}

function isWithinDirectory(path: string, directory: string): boolean {
  return resolvedPath(path).startsWith(resolvedPath(directory) + sep)
}

async function makeUniqueDestination(archivePath: string, workspaceDirectory: string): Promise<string> {
  const parent = join(workspaceDirectory, 'prepared')
  await mkdir(parent, { recursive: true })
  const stem = safeComponent(archiveStem(basename(archivePath)), '-_.', 'project')
  for (let suffix = 0; ; suffix += 1) {
    const candidate = join(parent, suffix === 0 ? stem : `${stem}_${suffix}`)
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** The archive name without `.tar.gz`, `.tgz`, `.tar`, `.zip` or another extension. */
export function archiveStem(name: string): string {
  const lowercase = name.toLowerCase()
  for (const suffix of ['.tar.gz', '.tgz', '.tar', '.zip']) {
    if (lowercase.endsWith(suffix)) return name.slice(0, name.length - suffix.length)
  }
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export interface ArXivProjectAcquiring {
  acquireProject(identifier: string, workspaceDirectory: string, signal?: AbortSignal): Promise<TranslationProjectSource>
}

export class ArXivProjectPreparer implements TranslationProjectPreparing {
  private readonly localDirectoryPreparer = new LocalDirectoryProjectPreparer()
  private readonly archivePreparer?: SecureArchiveProjectPreparer

  constructor(private readonly acquirer: ArXivProjectAcquiring, archiveReader?: TranslationArchiveReading, archiveLimits: Partial<ArchiveExtractionLimits> = {}) {
    this.archivePreparer = archiveReader ? new SecureArchiveProjectPreparer(archiveReader, archiveLimits) : undefined
  }

  async prepare(request: TranslationRequest, signal?: AbortSignal): Promise<PreparedProject> {
    const { source } = request
    if (source.kind !== 'arxiv') throw new TranslationPipelineError({ kind: 'unsupportedSource', source })
    if (!isValidArXivIdentifier(source.identifier)) throw new ProjectPreparationError({ kind: 'invalidArXivIdentifier', identifier: source.identifier })
    checkCancellation(signal)
    const acquired = await this.acquirer.acquireProject(source.identifier, request.workspaceDirectory, signal)
    const acquiredRequest: TranslationRequest = { ...request, source: acquired }
    let prepared: PreparedProject
    switch (acquired.kind) {
      case 'localDirectory':
        prepared = await this.localDirectoryPreparer.prepare(acquiredRequest)
        break
      case 'localArchive':
        if (!this.archivePreparer) throw new TranslationPipelineError({ kind: 'unsupportedSource', source: acquired })
        prepared = await this.archivePreparer.prepare(acquiredRequest, signal)
        break
      case 'arxiv':
        throw new ProjectPreparationError({ kind: 'unsupportedAcquiredSource' })
    }
    return { identifier: source.identifier, sourceDirectory: prepared.sourceDirectory, workspaceDirectory: prepared.workspaceDirectory }
  }
}

/** New-style (`2401.12345`) and old-style (`hep-th/9901001`) identifiers, with an optional version. */
export function isValidArXivIdentifier(identifier: string): boolean {
  return /^(?:\p{Nd}{4}\.\p{Nd}{4,5}|[A-Za-z.-]+\/\p{Nd}{7})(?:v\p{Nd}+)?$/u.test(identifier)
}

export class RoutedProjectPreparer implements TranslationProjectPreparing {
  private readonly localDirectory: LocalDirectoryProjectPreparer

  constructor(private readonly preparers: { localDirectory?: LocalDirectoryProjectPreparer; localArchive?: SecureArchiveProjectPreparer; arXiv?: ArXivProjectPreparer } = {}) {
    this.localDirectory = preparers.localDirectory ?? new LocalDirectoryProjectPreparer()
  }

  async prepare(request: TranslationRequest, signal?: AbortSignal): Promise<PreparedProject> {
    switch (request.source.kind) {
      case 'localDirectory':
        return this.localDirectory.prepare(request)
      case 'localArchive':
        if (!this.preparers.localArchive) throw new TranslationPipelineError({ kind: 'unsupportedSource', source: request.source })
        return this.preparers.localArchive.prepare(request, signal)
      case 'arxiv':
        if (!this.preparers.arXiv) throw new TranslationPipelineError({ kind: 'unsupportedSource', source: request.source })
        return this.preparers.arXiv.prepare(request, signal)
    }
  }
}
