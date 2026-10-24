// Builds BabelDocKit/resources/wasm/{babeldoc.wasm,babeldoc.cjs}: the patched
// MuPDF 1.28.0, zstd 1.5.7 and the unchanged BabelDocMuPDFShim (its iOS-style
// static path) compiled to a single WebAssembly module with a pinned Emscripten
// toolchain. The products are committed, so packaging machines never need emsdk.
//
// Usage: node scripts/build-babeldoc-wasm.mjs [--check]
//   --check  verify the committed products and input pins without building.
// Requires: make, tar, curl, a host C compiler, and either EMSDK_HOME pointing
// at an emsdk checkout with the pinned version active-able, or emsdk on PATH
// (an emsdk is cloned and installed automatically into BabelDocKit/.build/emsdk
// when neither is present). Run on macOS or Linux.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const kit = join(repo, 'BabelDocKit')
const buildRoot = join(kit, '.build', 'wasm')
const defaultUpstream = resolve(repo, '..', 'reWriteBabelDoc')
const jobs = String(Math.min(8, cpus().length))

const manifest = JSON.parse(readFileSync(join(kit, 'resources', 'wasm-manifest.json'), 'utf8'))
const checkOnly = process.argv.includes('--check')

const fail = (message) => {
  console.error(`build-babeldoc-wasm: ${message}`)
  process.exit(1)
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`)
}

function download(url, destination, expectedSha256) {
  if (existsSync(destination) && sha256(destination) === expectedSha256) return
  mkdirSync(join(destination, '..'), { recursive: true })
  const temporary = `${destination}.download`
  run('curl', ['--fail', '--location', '--proto', '=https', '--retry', '3', '--retry-all-errors', '--show-error', '--output', temporary, url])
  if (sha256(temporary) !== expectedSha256) fail(`SHA-256 mismatch for ${url}`)
  renameSync(temporary, destination)
}

// ---------------------------------------------------------------- emsdk ----

function emsdkHome() {
  const candidates = [process.env.EMSDK_HOME, process.env.EMSDK, join(buildRoot, 'emsdk')].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'emsdk_env.sh'))) return candidate
  }
  try {
    const onPath = execFileSync('/bin/zsh', ['-c', 'command -v emsdk'], { encoding: 'utf8' }).trim()
    if (onPath) return resolve(onPath, '..')
  } catch { /* Not on PATH. */ }
  return null
}

function ensureEmsdk() {
  const existing = emsdkHome()
  if (existing) return existing
  const home = join(buildRoot, 'emsdk')
  mkdirSync(join(home, '..'), { recursive: true })
  if (!existsSync(home)) {
    console.log('Cloning emsdk (set EMSDK_HOME to use an existing checkout)...')
    run('git', ['clone', '--depth', '1', 'https://github.com/emscripten-core/emsdk.git', home])
  }
  run(join(home, 'emsdk'), ['install', manifest.emscriptenVersion])
  run(join(home, 'emsdk'), ['activate', manifest.emscriptenVersion])
  return home
}

/** Runs a command with the pinned emsdk environment sourced. */
function em(command, cwd) {
  const home = ensureEmsdk()
  const script = `source ${join(home, 'emsdk_env.sh')} >/dev/null 2>&1 && ${command}`
  const result = spawnSync('/bin/zsh', ['-c', script], { stdio: 'inherit', cwd })
  if (result.status !== 0) fail(`emshell command failed (${result.status}): ${command}`)
}

function emccVersion() {
  const home = ensureEmsdk()
  const out = execFileSync('/bin/zsh', ['-c', `source ${join(home, 'emsdk_env.sh')} >/dev/null 2>&1 && emcc --version`], { encoding: 'utf8' })
  return (out.match(/emcc \([^)]*\) (\S+)/) ?? [])[1] ?? ''
}

// ------------------------------------------------------------- products ----

function verifyProducts(label) {
  for (const name of ['babeldoc.wasm', 'babeldoc.cjs']) {
    const path = join(kit, 'resources', 'wasm', name)
    if (!existsSync(path)) fail(`${label}: ${name} is missing`)
    const pinned = manifest.outputs[name]
    if (sha256(path) !== pinned.sha256) fail(`${label}: ${name} does not match wasm-manifest.json`)
  }
  console.log(`build-babeldoc-wasm: ${label} — wasm and glue match wasm-manifest.json`)
}

// ------------------------------------------------------------- sources -----

function prepare(upstream) {
  const mupdf = manifest.mupdf
  const archive = join(buildRoot, mupdf.sourceArchiveURL.split('/').pop())
  download(mupdf.sourceArchiveURL, archive, mupdf.sourceArchiveSHA256)
  const sourceRoot = join(buildRoot, `mupdf-${mupdf.version}-source`)
  if (!existsSync(join(sourceRoot, 'Makefile'))) {
    mkdirSync(buildRoot, { recursive: true })
    run('tar', ['-xzf', archive, '-C', buildRoot])
  }
  const versionHeader = readFileSync(join(sourceRoot, 'include', 'mupdf', 'fitz', 'version.h'), 'utf8')
  if (!versionHeader.includes(`#define FZ_VERSION "${mupdf.version}"`)) fail('MuPDF source version mismatch')

  const patchedMarker = join(sourceRoot, '.babeldoc-patched')
  if (!existsSync(patchedMarker)) {
    for (const patch of mupdf.patches) {
      const patchPath = join(upstream, patch.file)
      if (!existsSync(patchPath)) fail(`patch ${patch.file} not found under ${upstream}`)
      if (sha256(patchPath) !== patch.sha256) fail(`patch ${patch.file} does not match wasm-manifest.json`)
      run('patch', ['-d', sourceRoot, '-p1', '--forward', '--batch', '-i', patchPath])
    }
    writeFileSync(patchedMarker, 'applied\n')
  }

  const zstd = manifest.zstd
  const zstdArchive = join(buildRoot, zstd.sourceArchiveURL.split('/').pop())
  download(zstd.sourceArchiveURL, zstdArchive, zstd.sourceArchiveSHA256)
  const zstdRoot = join(buildRoot, `zstd-${zstd.version}`)
  if (!existsSync(join(zstdRoot, 'lib'))) run('tar', ['-xzf', zstdArchive, '-C', buildRoot])

  const shim = join(upstream, 'Sources', 'BabelDocMuPDFShim', 'BabelDocMuPDFShim.c')
  if (!existsSync(shim)) fail(`shim not found at ${shim}`)
  if (sha256(shim) !== manifest.shim.sha256) fail('BabelDocMuPDFShim.c does not match wasm-manifest.json')
  return { sourceRoot, zstdRoot, shim }
}

// --------------------------------------------------------------- build -----

function build(upstream) {
  const { sourceRoot, zstdRoot, shim } = prepare(upstream)
  mkdirSync(join(buildRoot, 'obj'), { recursive: true })
  const include = join(upstream, 'Sources', 'BabelDocMuPDFShim', 'include')
  const mupdfInclude = join(sourceRoot, 'include')
  const eh = ['-fwasm-exceptions', '-sSUPPORT_LONGJMP=wasm']
  const compile = ['-O2', ...eh, '-DBABELDOC_MUPDF_STATIC', `-I${join(buildRoot, 'shim-include')}`, `-I${mupdfInclude}`]

  mkdirSync(join(buildRoot, 'shim-include'), { recursive: true })
  run('cp', ['-R', `${include}/.`, join(buildRoot, 'shim-include')])
  run('cp', [shim, join(buildRoot, 'obj', 'BabelDocMuPDFShim.c')])
  run('cp', [join(kit, 'native', 'babeldoc_wasm.c'), join(buildRoot, 'obj', 'babeldoc_wasm.c')])

  console.log('Compiling MuPDF for wasm (generate + libs, a few minutes)...')
  run('make', ['-C', sourceRoot, `-j${jobs}`, 'generate'])
  em(`emmake make -C '${sourceRoot}' OS=wasm build=release -j${jobs} libs xps=no svg=no html=no XCFLAGS='${manifest.build.xcflags.join(' ')}'`)

  console.log('Compiling zstd for wasm...')
  const zstdObjects = join(buildRoot, 'obj', 'zstd')
  mkdirSync(zstdObjects, { recursive: true })
  const zstdGroups = ['common', 'compress', 'decompress'].flatMap((group) =>
    readdirSync(join(zstdRoot, 'lib', group)).filter((file) => file.endsWith('.c')).map((file) => join(zstdRoot, 'lib', group, file))
  )
  for (const source of zstdGroups) {
    em(`emcc -O2 -I'${join(zstdRoot, 'lib')}' -DZSTD_MULTITHREAD=0 -DZSTD_LEGACY_SUPPORT=0 -c '${source}' -o '${join(zstdObjects, source.split('/').pop().replace(/\.c$/, '.o'))}'`)
  }
  em(`emar rcs '${join(buildRoot, 'libzstd-wasm.a')}' '${zstdObjects}'/*.o`)

  console.log('Compiling shim and adapter, linking module...')
  em(`emcc ${compile.join(' ')} -c '${join(buildRoot, 'obj', 'BabelDocMuPDFShim.c')}' -o '${join(buildRoot, 'obj', 'shim.o')}'`)
  em(`emcc ${compile.join(' ')} -c '${join(buildRoot, 'obj', 'babeldoc_wasm.c')}' -o '${join(buildRoot, 'obj', 'adapter.o')}'`)
  const exports = [
    '-sEXPORTED_FUNCTIONS=' + [
      '_babeldoc_wasm_extract_frontend_il', '_babeldoc_wasm_render_page', '_babeldoc_wasm_free',
      '_babeldoc_wasm_font_open', '_babeldoc_wasm_font_glyph', '_babeldoc_wasm_font_advance', '_babeldoc_wasm_font_advance_exact',
      '_babeldoc_wasm_font_names_match', '_babeldoc_wasm_font_reset',
      '_babeldoc_wasm_decode_base_operations',
      '_babeldoc_wasm_writer_open', '_babeldoc_wasm_writer_add_cid_font',
      '_babeldoc_wasm_writer_set_page_content', '_babeldoc_wasm_writer_set_object_content',
      '_babeldoc_wasm_writer_keep_pages', '_babeldoc_wasm_writer_save', '_babeldoc_wasm_writer_close',
      '_babeldoc_wasm_writer_apply_source_preserving_page',
      '_malloc', '_free'
    ].join(',')
  ]
  const runtime = ['-sEXPORTED_RUNTIME_METHODS=UTF8ToString,getValue,setValue,HEAPU8,stringToUTF8,lengthBytesUTF8']
  const link = [
    ...eh, '-O2', '-sMODULARIZE=1', '-sEXPORT_NAME=BabelDocWasm', '-sENVIRONMENT=node', '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=64MB', ...manifest.build.linkFlags.filter((flag) => flag.startsWith('-sSTACK_SIZE')),
    ...exports, ...runtime
  ]
  em(
    `emcc ${link.join(' ')} '${join(buildRoot, 'obj', 'adapter.o')}' '${join(buildRoot, 'obj', 'shim.o')}' ` +
    `'${join(sourceRoot, 'build/wasm/release/libmupdf.a')}' '${join(sourceRoot, 'build/wasm/release/libmupdf-third.a')}' ` +
    `'${join(buildRoot, 'libzstd-wasm.a')}' -o '${join(buildRoot, 'babeldoc.js')}'`
  )
  // The app package declares "type": "module"; the Emscripten glue is CommonJS,
  // so it ships with the explicit .cjs extension to stay requireable in-process.
  renameSync(join(buildRoot, 'babeldoc.js'), join(kit, 'resources', 'wasm', 'babeldoc.cjs'))
  run('cp', [join(buildRoot, 'babeldoc.wasm'), join(kit, 'resources', 'wasm', 'babeldoc.wasm')])

  const outputs = {}
  for (const name of ['babeldoc.wasm', 'babeldoc.cjs']) {
    const path = join(kit, 'resources', 'wasm', name)
    outputs[name] = { size: readFileSync(path).length, sha256: sha256(path) }
  }
  manifest.outputs = outputs
  manifest.adapter = { file: 'BabelDocKit/native/babeldoc_wasm.c', sha256: sha256(join(kit, 'native', 'babeldoc_wasm.c')) }
  writeFileSync(join(kit, 'resources', 'wasm-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`build-babeldoc-wasm: wrote ${outputs['babeldoc.wasm'].size} byte module; wasm-manifest.json updated`)
}

if (checkOnly) {
  verifyProducts('--check')
} else {
  const upstream = process.env.BABELDOC_UPSTREAM ?? defaultUpstream
  if (!existsSync(upstream)) fail(`reWriteBabelDoc checkout not found at ${upstream} (set BABELDOC_UPSTREAM)`)
  const version = emccVersion()
  if (version !== manifest.emscriptenVersion) {
    fail(`emcc ${version} does not match the pinned ${manifest.emscriptenVersion}`)
  }
  build(upstream)
  verifyProducts('build')
}
rmSync(join(buildRoot, 'obj'), { recursive: true, force: true })
