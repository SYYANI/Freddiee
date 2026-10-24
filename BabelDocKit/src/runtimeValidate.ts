// Shared runtime-manifest validation. Imported both by the app (through
// runtime.ts) and by scripts/verify-babeldoc-runtime.mjs, so it must stay
// free of Vite-only imports and non-erasable TypeScript syntax.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RuntimeManifestFile {
  file: string
  sha256: string
  size: number
  sourceURL?: string
}

export interface RuntimeManifest {
  schemaVersion: number
  kind: string
  layoutModel: RuntimeManifestFile & {
    url: string
    huggingFaceRepository: string
    convertedFrom: string
    license: string
    [extra: string]: unknown
  }
  fonts: { source: string; files: RuntimeManifestFile[] }
}

export interface RuntimeFileIssue {
  file: string
  problem:
    | 'missing'
    | 'size-mismatch'
    | 'hash-mismatch'
    | 'not-a-regular-file'
    | 'symlink'
    | 'unexpected-file'
    | 'unexpected-directory'
    | 'bad-manifest'
  expectedSize?: number
  actualSize?: number
  expectedSha256?: string
}

export interface RuntimeVerification {
  valid: boolean
  issues: RuntimeFileIssue[]
  /** Every manifest file that is present and intact. */
  verifiedFiles: string[]
}

const isSha256 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

/** Present in the synced directory but never packaged: upstream provenance
 * records and Finder artifacts that appear on macOS machines. */
const informationalFiles = new Set(['UPSTREAM.json', '.DS_Store'])

function sha256File(path: string): string {
  const hasher = createHash('sha256')
  hasher.update(readFileSync(path))
  return hasher.digest('hex')
}

function walk(root: string, relative = '', out: { files: string[]; directories: string[]; symlinks: string[] }): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) {
      out.symlinks.push(child)
      continue
    }
    if (entry.isDirectory()) {
      out.directories.push(child)
      walk(root, child, out)
    } else if (entry.isFile()) {
      out.files.push(child)
    } else {
      out.files.push(child)
    }
  }
}

/**
 * Validates a babeldoc runtime directory against the committed manifest, with
 * the same strictness as the Swift BabelDocRuntime verifier: every expected
 * file must be a regular, non-symlink file with the pinned size and SHA-256,
 * and anything else inside the directory is rejected.
 */
export function validateRuntimeDirectory(root: string, manifest: RuntimeManifest): RuntimeVerification {
  const issues: RuntimeFileIssue[] = []
  if (manifest.schemaVersion !== 1) {
    issues.push({ file: 'runtime-manifest.json', problem: 'bad-manifest', expectedSize: manifest.schemaVersion })
    return { valid: false, issues, verifiedFiles: [] }
  }

  const expected = new Map<string, RuntimeManifestFile>()
  for (const file of [manifest.layoutModel, ...manifest.fonts.files]) {
    if (!file.file.startsWith('fonts/') && !file.file.startsWith('models/')) {
      issues.push({ file: file.file, problem: 'bad-manifest' })
      continue
    }
    if (!Number.isInteger(file.size) || file.size < 0 || !isSha256(file.sha256)) {
      issues.push({ file: file.file, problem: 'bad-manifest' })
      continue
    }
    expected.set(file.file, file)
  }
  if (issues.length > 0) return { valid: false, issues, verifiedFiles: [] }

  const present = { files: [] as string[], directories: [] as string[], symlinks: [] as string[] }
  try {
    walk(root, '', present)
  } catch (error) {
    issues.push({ file: String(root), problem: 'unexpected-directory' })
    return { valid: false, issues, verifiedFiles: [] }
  }

  for (const symlink of present.symlinks) {
    issues.push({ file: symlink, problem: 'symlink' })
  }

  const verified: string[] = []
  for (const [relative, asset] of expected) {
    const path = join(root, relative)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path)
    } catch {
      issues.push({ file: relative, problem: 'missing' })
      continue
    }
    if (stat.isSymbolicLink()) {
      issues.push({ file: relative, problem: 'symlink' })
      continue
    }
    if (!stat.isFile()) {
      issues.push({ file: relative, problem: 'not-a-regular-file' })
      continue
    }
    if (stat.size !== asset.size) {
      issues.push({
        file: relative, problem: 'size-mismatch', expectedSize: asset.size, actualSize: stat.size
      })
      continue
    }
    const actual = sha256File(path)
    if (actual !== asset.sha256) {
      issues.push({
        file: relative, problem: 'hash-mismatch', expectedSha256: asset.sha256
      })
      continue
    }
    verified.push(relative)
  }

  const expectedNames = new Set(expected.keys())
  for (const file of present.files) {
    if (informationalFiles.has(file)) continue
    if (!expectedNames.has(file)) issues.push({ file, problem: 'unexpected-file' })
  }

  return { valid: issues.length === 0, issues, verifiedFiles: verified }
}

export function describeRuntimeIssues(verification: RuntimeVerification): string {
  const lines = verification.issues.map((issue) => {
    switch (issue.problem) {
      case 'missing':
        return `${issue.file}: missing from the babeldoc runtime`
      case 'size-mismatch':
        return `${issue.file}: expected ${issue.expectedSize} bytes, found ${issue.actualSize}`
      case 'hash-mismatch':
        return `${issue.file}: SHA-256 does not match the pinned ${issue.expectedSha256}`
      case 'not-a-regular-file':
        return `${issue.file}: not a regular file`
      case 'symlink':
        return `${issue.file}: symbolic links are not accepted`
      case 'unexpected-file':
        return `${issue.file}: not part of the pinned babeldoc runtime`
      case 'bad-manifest':
        return `${issue.file}: the runtime manifest entry is malformed`
      case 'unexpected-directory':
      default:
        return `${issue.file}: the runtime directory cannot be read`
    }
  })
  return lines.join('\n')
}
