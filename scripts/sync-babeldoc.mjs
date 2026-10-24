// Synchronizes the gitignored BabelDocKit/runtime directory from a reWriteBabelDoc
// checkout: the upstream DocLayout-YOLO ONNX model (byte for byte, hash-pinned
// in BabelDocKit/resources/runtime-manifest.json) and the pinned target fonts
// with their license files. Downloading from HuggingFace is only a fallback for
// machines without the sibling checkout. Run before packaging; package:* scripts
// refuse to build when the runtime does not verify.
//
// With --parity, also regenerates the stage parity fixtures under
// tests/fixtures/babeldoc by running the Swift pipeline (scripts/babeldoc-parity)
// against the -ffp-contract=off reference dylib.
//
// Usage: node scripts/sync-babeldoc.mjs [/path/to/reWriteBabelDoc] [--parity]
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const runtime = join(repo, 'BabelDocKit', 'runtime')
const manifest = JSON.parse(readFileSync(join(repo, 'BabelDocKit', 'resources', 'runtime-manifest.json'), 'utf8'))

const fail = (message) => {
  console.error(`sync-babeldoc: ${message}`)
  process.exit(1)
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function download(url, destination, expectedSha256) {
  mkdirSync(join(destination, '..'), { recursive: true })
  const temporary = `${destination}.download`
  console.log(`Downloading ${url}`)
  execFileSync('curl', ['--fail', '--location', '--proto', '=https', '--retry', '3', '--retry-all-errors', '--show-error', '--output', temporary, url], { stdio: 'inherit' })
  if (sha256(temporary) !== expectedSha256) {
    unlinkSync(temporary)
    fail(`downloaded ${url} does not match the pinned SHA-256 ${expectedSha256}`)
  }
  renameSync(temporary, destination)
}

/** Copies one pinned asset into the runtime, verifying hash and size. */
function place(asset, source) {
  const target = join(runtime, asset.file)
  mkdirSync(join(target, '..'), { recursive: true })
  if (!existsSync(source)) return false
  if (lstatSync(source).isSymbolicLink()) fail(`${source} is a symbolic link; the runtime must contain real files`)
  if (statSync(source).size !== asset.size || sha256(source) !== asset.sha256) {
    fail(`${source} does not match the pinned manifest entry for ${asset.file}`)
  }
  const temporary = `${target}.copy`
  execFileSync('cp', [source, temporary])
  if (statSync(temporary).size !== asset.size || sha256(temporary) !== asset.sha256) {
    unlinkSync(temporary)
    fail(`copy of ${asset.file} arrived damaged`)
  }
  renameSync(temporary, target)
  return true
}

function walkFiles(directory, prefix = '') {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...walkFiles(join(directory, entry.name), relative))
    else out.push(relative)
  }
  return out
}

const upstreamArg = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
const upstream = resolve(upstreamArg ?? process.env.BABELDOC_UPSTREAM ?? '../reWriteBabelDoc')
const model = manifest.layoutModel
const assets = [model, ...manifest.fonts.files]
const upstreamModel = join(upstream, 'Vendor', 'Models', model.file.split('/').pop())

/** A manifest path (fonts/…, models/…) relative to the upstream Vendor directories. */
const upstreamRelative = (file) => file.replace(/^(fonts|models)\//, '')

mkdirSync(runtime, { recursive: true })
if (existsSync(upstreamModel)) {
  place(model, upstreamModel)
} else {
  console.log(`Model not found at ${upstreamModel}; downloading from ${model.huggingFaceRepository}`)
  download(model.url, join(runtime, model.file), model.sha256)
}

const upstreamFontsManifest = join(upstream, 'Vendor', 'Fonts', 'manifest.json')
if (!existsSync(upstreamFontsManifest)) fail(`fonts manifest not found at ${upstreamFontsManifest}`)
const upstreamFonts = JSON.parse(readFileSync(upstreamFontsManifest, 'utf8'))
const byName = new Map(upstreamFonts.assets.map((asset) => [`fonts/${asset.file}`, asset]))
for (const license of upstreamFonts.licenses) byName.set(`fonts/${license.file}`, license)
for (const asset of manifest.fonts.files) {
  const upstreamEntry = byName.get(asset.file)
  if (!upstreamEntry || upstreamEntry.sha256 !== asset.sha256 || upstreamEntry.size !== asset.size) {
    fail(`reWriteBabelDoc fonts manifest disagrees with our pinned entry for ${asset.file}`)
  }
  const source = join(upstream, 'Vendor', 'Fonts', upstreamRelative(asset.file))
  if (!place(asset, source)) {
    const sourceURL = asset.sourceURL ?? upstreamEntry.sourceURL
    if (!sourceURL) fail(`${asset.file} is missing under ${join(upstream, 'Vendor', 'Fonts')} and has no download source`)
    download(sourceURL, join(runtime, asset.file), asset.sha256)
  }
}

// Refuse to leave anything the runtime validator would reject.
const expected = new Set([...assets.map((asset) => asset.file), 'UPSTREAM.json', '.DS_Store'])
for (const file of walkFiles(runtime)) {
  if (!expected.has(file)) {
    console.log(`Removing unexpected ${file} from BabelDocKit/runtime`)
    rmSync(join(runtime, file))
  }
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch { /* Not a git checkout. */ }
writeFileSync(join(runtime, 'UPSTREAM.json'), `${JSON.stringify({ repository: 'reWriteBabelDoc', commit }, null, 2)}\n`)

const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0)
console.log(`Synchronized ${assets.length} babeldoc runtime files (${(totalBytes / 1e6).toFixed(1)} MB) from ${upstream} (${commit})`)

// ------------------------------------------------------------------ parity --

if (process.argv.includes('--parity')) {
  const fixturesRoot = join(repo, 'tests', 'fixtures', 'babeldoc')
  const parityDylib = join(repo, 'BabelDocKit', '.build', 'parity', 'libmupdf.dylib')
  const model = join(upstream, 'Vendor', 'Models', 'doclayout_yolo_docstructbench_imgsz1024.mlmodel')

  spawnSync(process.execPath, [join(repo, 'scripts', 'build-babeldoc-parity-dylib.mjs')], { stdio: 'inherit' })
  if (!existsSync(parityDylib)) fail('the parity reference dylib is missing')

  const harnessRoot = join(repo, 'scripts', 'babeldoc-parity')
  execFileSync('swift', ['build', '-c', 'release'], { cwd: harnessRoot, stdio: 'inherit' })
  const harness = join(harnessRoot, '.build', 'release', 'babeldoc-parity')

  rmSync(fixturesRoot, { recursive: true, force: true })
  mkdirSync(join(fixturesRoot, 'pdf'), { recursive: true })
  // Small synthetic frontend fixtures (all pages) plus two pages of a compact
  // real paper; richer real-page fixtures (text/table/jump.pdf) can be dumped
  // ad hoc with the same harness but are too large to commit.
  const corpus = [
    ...readdirSync(join(upstream, 'fixtures', 'stage2', 'pdf-frontend'))
      .filter((file) => file.endsWith('.pdf'))
      .map((file) => ({ name: file.replace(/\.pdf$/, ''), path: join(upstream, 'fixtures', 'stage2', 'pdf-frontend', file), pages: null })),
    { name: 'paper-p1', path: join(upstream, 'test-pdf', '800-789.pdf'), pages: '1-1' }
  ]
  let totalFixtureBytes = 0
  // The shim resolves zstd through BABELDOC_ZSTD_LIBRARY; without it the
  // harness cwd hides Vendor/Zstd and base_operations come back uncompressed.
  const harnessEnv = {
    ...process.env,
    BABELDOC_ZSTD_LIBRARY: join(upstream, 'Vendor', 'Zstd', 'lib', 'libzstd.dylib')
  }
  const fontDirectory = join(upstream, 'Vendor', 'Fonts')
  for (const item of corpus) {
    const outDir = join(fixturesRoot, item.name)
    const args = [
      'stages', item.path, outDir, '--cpu', '--model', model,
      '--mupdf-library', parityDylib, '--font-directory', fontDirectory
    ]
    if (item.pages) args.push('--pages', item.pages)
    execFileSync(harness, args, { stdio: 'inherit', env: harnessEnv })
    copyFileSync(item.path, join(fixturesRoot, 'pdf', `${item.name}.pdf`))
    // The 1-based page selection the stage JSONs cover (null = every page).
    const [firstPage, lastPage] = item.pages ? item.pages.split('-').map(Number) : [0, -1]
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({
      pdf: `pdf/${item.name}.pdf`,
      pages: item.pages
        ? Array.from({ length: lastPage - firstPage + 1 }, (_, offset) => firstPage + offset)
        : null
    }, null, 2)}\n`)
    for (const stage of readdirSync(outDir)) {
      totalFixtureBytes += statSync(join(outDir, stage)).size
    }
    totalFixtureBytes += statSync(item.path).size
  }
  console.log(`Regenerated ${corpus.length} babeldoc parity fixtures (${(totalFixtureBytes / 1e6).toFixed(1)} MB)`)
}
