// Font availability for the backend: which target font files exist in the
// runtime directory (Swift checks the filesystem per font id) and which names
// have already been opened inside the wasm module, so the writer can resolve
// them from MEMFS.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { babelDocWasm } from './wasmModule'
import { classificationFontNames } from './targetFonts'

const openedNames = new Set<string>()

export interface FontTable {
  directory: string
  has(name: string): boolean
}

export function fontDirectory(directory?: string | null): FontTable {
  const resolved = directory ?? process.env.BABELDOC_FONT_DIRECTORY ?? 'BabelDocKit/runtime/fonts'
  return {
    directory: resolved,
    has(name: string): boolean {
      return existsSync(join(resolved, name))
    }
  }
}

/** Opens every runtime target font in the wasm module once per process; the
 * writer resolves font names against the same MEMFS copies. */
export async function ensureWriterFontsLoaded(directory?: string | null): Promise<void> {
  const table = fontDirectory(directory)
  const wasm = await babelDocWasm()
  for (const name of classificationFontNames) {
    if (openedNames.has(name) || !table.has(name)) continue
    wasm.fontOpen(new Uint8Array(readFileSync(join(table.directory, name))), name)
    openedNames.add(name)
  }
}
