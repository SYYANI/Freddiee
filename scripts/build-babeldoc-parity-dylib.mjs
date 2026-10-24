// Builds the parity-reference libmupdf.dylib: the same pinned, patched MuPDF
// 1.28.0 compiled for macOS with -ffp-contract=off. The reWriteBabelDoc Swift
// CLI runs against this dylib (via --mupdf-library) when generating frontend-IL
// parity fixtures, so its floating-point arithmetic matches the wasm build,
// which never contracts: frontend IL then compares bit for bit. The reWriteBabelDoc
// repository and its own Vendor build stay untouched; the dylib lands in the
// gitignored BabelDocKit/.build/parity.
//
// Usage: node scripts/build-babeldoc-parity-dylib.mjs [--force]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const buildRoot = join(repo, 'BabelDocKit', '.build')
const parityRoot = join(buildRoot, 'parity')
const wasmManifest = JSON.parse(readFileSync(join(repo, 'BabelDocKit', 'resources', 'wasm-manifest.json'), 'utf8'))
const force = process.argv.includes('--force')
const jobs = String(Math.min(8, cpus().length))

const fail = (message) => {
  console.error(`build-babeldoc-parity-dylib: ${message}`)
  process.exit(1)
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`)
}

const upstream = resolve(process.env.BABELDOC_UPSTREAM ?? '../reWriteBabelDoc')
const output = join(parityRoot, 'libmupdf.dylib')
if (existsSync(output) && !force) {
  console.log(`build-babeldoc-parity-dylib: ${output} already exists (use --force to rebuild)`)
  process.exit(0)
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail('the parity reference dylib is built for macOS arm64 only')
}

const mupdf = wasmManifest.mupdf
mkdirSync(parityRoot, { recursive: true })
const sourceRoot = join(buildRoot, 'wasm', `mupdf-${mupdf.version}-source`)
if (!existsSync(join(sourceRoot, 'Makefile'))) {
  fail(`patched MuPDF source not found at ${sourceRoot}; run scripts/build-babeldoc-wasm.mjs first`)
}

console.log('Building the no-FMA reference dylib (a few minutes)...')
// Disable pkg-config so MuPDF bundles its own thirdparty (zlib, lcms, ...)
// exactly like the wasm build; system zlib would deflate streams differently
// and break byte-level PDF parity with the wasm module.
const environment = { ...process.env, PKG_CONFIG: '/usr/bin/false' }
run('make', ['-C', sourceRoot, `-j${jobs}`, 'shared=yes', 'build=release', 'HAVE_GLUT=no', 'HAVE_X11=no',
  'ARCHFLAGS=-arch arm64', 'MACOSX_DEPLOYMENT_TARGET=11.0', 'XCFLAGS=-ffp-contract=off', 'libs'],
  { env: environment })
run('cp', [join(sourceRoot, 'build', 'shared-release', 'libmupdf.dylib'), output])
run('codesign', ['--force', '--sign', '-', '--identifier', 'libmupdf.babeldoc-parity', output])
writeFileSync(join(parityRoot, 'README.txt'),
  'Reference libmupdf.dylib built with -ffp-contract=off from the wasm-manifest-pinned\n' +
  `MuPDF ${mupdf.version} source and patches. Used only to generate parity fixtures.\n`)
console.log(`build-babeldoc-parity-dylib: wrote ${output} (sha256 ${sha256(output)})`)
