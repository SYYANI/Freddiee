import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'
import type { LatexExecutableStatus, LatexInstallationStatus, LatexToolchainStatus } from '../../shared/types'

export const latexExecutableNames = [
  'latexmk',
  'latex',
  'pdflatex',
  'xelatex',
  'lualatex',
  'bibtex',
  'biber',
  'makeindex'
] as const

const pdfEngineNames = new Set(['xelatex', 'pdflatex', 'lualatex'])

interface InspectedLatexExecutable extends LatexExecutableStatus {
  path?: string
}

interface InspectedLatexInstallation {
  directory: string
  executables: InspectedLatexExecutable[]
  healthy: boolean
}

async function executablePath(directory: string, name: string, extensions: readonly string[]): Promise<string | undefined> {
  for (const extension of extensions) {
    const candidate = resolve(directory, name + extension)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

export function isHealthyLatexInstallation(executables: LatexExecutableStatus[]): boolean {
  return executables.some((executable) => executable.name === 'latexmk' && executable.isAvailable)
    && executables.some((executable) => pdfEngineNames.has(executable.name) && executable.isAvailable)
}

export async function inspectLatexInstallation(
  directory: string,
  extensions: readonly string[] = process.platform === 'win32' ? ['.exe'] : ['']
): Promise<InspectedLatexInstallation> {
  const normalized = resolve(directory)
  const executables = await Promise.all(latexExecutableNames.map(async (name) => {
    const path = await executablePath(normalized, name, extensions)
    return { name, path, isAvailable: Boolean(path) }
  }))
  return { directory: normalized, executables, healthy: isHealthyLatexInstallation(executables) }
}

function pathFor(installation: InspectedLatexInstallation | undefined, name: string): string | undefined {
  return installation?.executables.find((executable) => executable.name === name)?.path
}

function publicInstallation(installation: InspectedLatexInstallation | undefined): LatexInstallationStatus | undefined {
  if (!installation) return undefined
  return {
    directory: installation.directory,
    executables: installation.executables.map(({ name, isAvailable }) => ({ name, isAvailable })),
    healthy: installation.healthy
  }
}

/** Mirrors the native Freddie toolchain picker and its eight-command health summary. */
export async function detectLatexToolchainStatus(options: {
  manualDirectory?: string
  searchDirectories: string[]
  extensions?: readonly string[]
}): Promise<Omit<LatexToolchainStatus, 'detail'>> {
  const extensions = options.extensions ?? (process.platform === 'win32' ? ['.exe'] : [''])
  const normalizedSearchDirectories = [...new Set(options.searchDirectories.map((directory) => resolve(directory)))]
  const inspected = await Promise.all(normalizedSearchDirectories.map((directory) => inspectLatexInstallation(directory, extensions)))
  const automatic = inspected.find((installation) => Boolean(pathFor(installation, 'latexmk')))

  const manualDirectory = options.manualDirectory ? resolve(options.manualDirectory) : undefined
  const manual = manualDirectory
    ? inspected.find((installation) => installation.directory === manualDirectory)
      ?? await inspectLatexInstallation(manualDirectory, extensions)
    : undefined
  const active = manual ?? automatic

  const detected = inspected.filter((installation) => installation.executables.some((executable) => executable.isAvailable))
  if (manual && !detected.some((installation) => installation.directory === manual.directory)) detected.push(manual)
  detected.sort((left, right) => left.directory.localeCompare(right.directory, undefined, { numeric: true, sensitivity: 'base' }))

  const xelatexInstallation = [manual, ...inspected]
    .filter((installation): installation is InspectedLatexInstallation => Boolean(installation))
    .find((installation) => Boolean(pathFor(installation, 'xelatex')))

  return {
    latexmkPath: pathFor(active, 'latexmk'),
    xelatexPath: pathFor(xelatexInstallation, 'xelatex'),
    automaticDirectory: automatic?.directory,
    active: publicInstallation(active),
    installations: detected.map((installation) => publicInstallation(installation)!),
    healthy: active?.healthy ?? false
  }
}
