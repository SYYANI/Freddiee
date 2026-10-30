import { lstatSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { SyncError, type Scope } from './types'

const unsafe = (): SyncError => new SyncError('The synced file path is not safe.')

/** Paper and writing folders, laid out as in native Freddie's Application Support. */
export function scopeDirectory(root: string, scope: Scope): string {
  if (scope.paperId && !scope.writingId) return join(root, 'Library', scope.paperId)
  if (scope.writingId && !scope.paperId) return join(root, 'Writings', scope.writingId)
  throw new SyncError('The synced document scope is not valid.')
}

/** Resolves a synced relative path, refusing traversal, reserved names and links on the way. */
export function scopedFile(root: string, scope: Scope, path: string): string {
  if (!path || Buffer.byteLength(path) > 4096 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw unsafe()
  const components = path.split('/')
  if (components.length > 32 || components.some((part) => !part || part === '.' || part === '..' || part.startsWith('.Sync'))) throw unsafe()
  // Names Windows cannot store would land somewhere else than the path says.
  if (process.platform === 'win32' && components.some((part) => /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw unsafe()
  const base = resolve(root)
  const target = resolve(scopeDirectory(root, scope), ...components)
  if (!target.startsWith(`${base}${sep}`)) throw unsafe()
  let current = base
  for (const part of relative(base, target).split(sep)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new SyncError('Sync cannot read a symbolic link or special file.')
    } catch (error) {
      if (error instanceof SyncError) throw error
      break // Missing components are created later.
    }
  }
  return target
}

/** The synced form of a local path inside a scope, or undefined when it lies outside. */
export function scopedRelativePath(root: string, scope: Scope, absolute: string): string | undefined {
  const directory = resolve(scopeDirectory(root, scope))
  const target = resolve(absolute)
  if (!target.startsWith(`${directory}${sep}`)) return undefined
  const path = relative(directory, target).split(sep).join('/')
  try {
    scopedFile(root, scope, path)
    return path
  } catch {
    return undefined
  }
}
