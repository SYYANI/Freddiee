// Loading of the committed BabelDoc wasm module (patched MuPDF 1.28 + zstd +
// the unchanged BabelDocMuPDFShim static path). The .wasm and its JS glue are
// build products committed under BabelDocKit/resources/wasm; inside the app
// they live in the asar, so the bytes are read with fs rather than fetched.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import wasmManifestJson from '../resources/wasm-manifest.json'

export interface WasmManifest {
  schemaVersion: number
  kind: string
  emscriptenVersion: string
  outputs: Record<'babeldoc.wasm' | 'babeldoc.cjs', { size: number; sha256: string }>
  [extra: string]: unknown
}

export const wasmManifest = wasmManifestJson as unknown as WasmManifest

export class BabelDocWasmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BabelDocWasmError'
  }
}

/**
 * Resolves the directory holding babeldoc.wasm and babeldoc.cjs: the repository
 * checkout in development and tests, the asar copy in a packaged app (the
 * caller passes `app.getAppPath()`). The glue uses the .cjs extension because
 * the app package declares `"type": "module"`, which would otherwise turn the
 * Emscripten CommonJS glue into an unparseable ES module.
 */
export function babeldocWasmDirectory(appPath: string = process.cwd()): string {
  const configuredAppPath = process.env.FREDDIE_APP_PATH
  for (const root of [configuredAppPath, appPath]) {
    if (!root) continue
    const packaged = join(root, 'BabelDocKit', 'resources', 'wasm')
    if (existsSync(join(packaged, 'babeldoc.wasm'))) return packaged
  }
  return join(process.cwd(), 'BabelDocKit', 'resources', 'wasm')
}

export interface BabelDocWasmBundle {
  directory: string
  /** Uncompressed module bytes, exactly the committed artifact. */
  wasm: Buffer
  /** The Emscripten JS glue for the module. */
  glue: string
}

/** Reads and hash-verifies the committed wasm module and JS glue. */
export function loadBabelDocWasm(appPath: string = process.cwd()): BabelDocWasmBundle {
  const directory = babeldocWasmDirectory(appPath)
  const bundle: BabelDocWasmBundle = {
    directory,
    wasm: readFileSync(join(directory, 'babeldoc.wasm')),
    glue: readFileSync(join(directory, 'babeldoc.cjs'), 'utf8')
  }
  for (const name of ['babeldoc.wasm', 'babeldoc.cjs'] as const) {
    const pinned = wasmManifest.outputs[name]
    const bytes = name === 'babeldoc.wasm' ? bundle.wasm : Buffer.from(bundle.glue, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== pinned.size || sha256 !== pinned.sha256) {
      throw new BabelDocWasmError(
        `BabelDocKit/resources/wasm/${name} does not match wasm-manifest.json ` +
        `(expected ${pinned.size} bytes, sha256 ${pinned.sha256}).`
      )
    }
  }
  return bundle
}
