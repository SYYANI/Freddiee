// Resolution and strict validation of the babeldoc runtime directory: the
// layout ONNX model and the pinned target fonts. The directory is synced from
// a reWriteBabelDoc checkout by scripts/sync-babeldoc.mjs (development) and
// ships as extraResources at process.resourcesPath/babeldoc (packaged).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import manifestJson from '../resources/runtime-manifest.json'
import {
  describeRuntimeIssues, validateRuntimeDirectory,
  type RuntimeManifest, type RuntimeVerification
} from './runtimeValidate'

export const runtimeManifest = manifestJson as unknown as RuntimeManifest

export class BabelDocRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocRuntimeError'
  }
}

/** The babeldoc runtime directory for this process. */
export function babeldocRuntimeDirectory(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath && existsSync(join(resourcesPath, 'babeldoc', 'models'))) {
    return join(resourcesPath, 'babeldoc')
  }
  return join(process.cwd(), 'BabelDocKit', 'runtime')
}

export function layoutModelPath(directory: string = babeldocRuntimeDirectory()): string {
  return join(directory, runtimeManifest.layoutModel.file)
}

export function fontDirectory(directory: string = babeldocRuntimeDirectory()): string {
  return join(directory, 'fonts')
}

/**
 * Throws a {@link BabelDocRuntimeError} naming every problem when the runtime
 * directory does not exactly match the pinned manifest. Same semantics as the
 * Swift BabelDocRuntime verifier: missing or wrong files, symbolic links and
 * unexpected extra files all fail.
 */
export function verifyBabelDocRuntime(directory: string = babeldocRuntimeDirectory()): RuntimeVerification {
  const verification = validateRuntimeDirectory(directory, runtimeManifest)
  if (!verification.valid) {
    throw new BabelDocRuntimeError(
      `The babeldoc runtime at ${directory} is incomplete or modified.\n${describeRuntimeIssues(verification)}`
    )
  }
  return verification
}
