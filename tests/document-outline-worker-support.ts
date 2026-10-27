import { join, resolve } from 'node:path'
import { build } from 'esbuild'

/** Build the same worker entry used by Electron, in an isolated test directory. */
export async function compileOutlineWorker(directory: string): Promise<string> {
  const outfile = join(directory, 'documentOutlineWorker.cjs')
  await build({ entryPoints: [resolve('electron/main/documentOutlineWorker.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  return outfile
}
