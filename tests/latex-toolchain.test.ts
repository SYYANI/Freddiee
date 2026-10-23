import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectLatexToolchainStatus, inspectLatexInstallation, latexExecutableNames } from '../electron/main/latexToolchain'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'freddie-latex-toolchain-'))
  temporaryDirectories.push(directory)
  return directory
}

function makeExecutable(directory: string, name: string): string {
  const path = join(directory, name)
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LaTeX toolchain detection', () => {
  it('reports the same eight executables as native Freddie', async () => {
    const directory = temporaryDirectory()
    makeExecutable(directory, 'latexmk')
    makeExecutable(directory, 'pdflatex')

    const installation = await inspectLatexInstallation(directory, [''])

    expect(installation.executables.map((executable) => executable.name)).toEqual([...latexExecutableNames])
    expect(installation.executables.filter((executable) => executable.isAvailable).map((executable) => executable.name)).toEqual(['latexmk', 'pdflatex'])
    expect(installation.healthy).toBe(true)
  })

  it('requires latexmk and any PDF engine for the basic health check', async () => {
    const directory = temporaryDirectory()
    makeExecutable(directory, 'latexmk')
    expect((await inspectLatexInstallation(directory, [''])).healthy).toBe(false)

    makeExecutable(directory, 'lualatex')
    expect((await inspectLatexInstallation(directory, [''])).healthy).toBe(true)
  })

  it('keeps an incomplete manually selected directory visible and detects automatic installations', async () => {
    const manual = temporaryDirectory()
    const automatic = temporaryDirectory()
    makeExecutable(automatic, 'latexmk')
    const xelatex = makeExecutable(automatic, 'xelatex')

    const status = await detectLatexToolchainStatus({ manualDirectory: manual, searchDirectories: [automatic], extensions: [''] })

    expect(status.active?.directory).toBe(manual)
    expect(status.healthy).toBe(false)
    expect(status.automaticDirectory).toBe(automatic)
    expect(status.xelatexPath).toBe(xelatex)
    expect(new Set(status.installations.map((installation) => installation.directory))).toEqual(new Set([automatic, manual]))
  })
})
