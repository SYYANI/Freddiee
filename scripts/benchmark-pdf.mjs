// Run with a GUI session: node scripts/benchmark-pdf.mjs
// Real PDFs are copied into an isolated temporary library. The source library is read-only.
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'electron-vite'
import electron from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const work = process.env.FREDDIE_BENCH_DIR || await mkdtemp(join(tmpdir(), 'freddie-pdf-bench-'))
await mkdir(work, { recursive: true })
const sourceRoot = process.env.FREDDIE_BENCH_LIBRARY || join(homedir(), 'Library/Application Support/Freddie')
const source = JSON.parse(await readFile(join(sourceRoot, 'library.json'), 'utf8'))
const candidates = process.env.FREDDIE_BENCH_PAPERS?.split(',') || [
  // Local test selection can be overridden without changing the benchmark.
  ...source.attachments.filter((item) => item.kind === 'pdf').slice(-2).map((item) => item.paperId)
]
const scenarios = candidates.map((paperId, index) => ({
  label: `document-${index + 1}`, paperId,
  mode: process.env.FREDDIE_BENCH_MODE || (index === 1 && source.attachments.some((item) => item.paperId === paperId && item.kind === 'translatedPDF') ? 'bilingualPDF' : 'pdf')
}))
if (!scenarios.length) throw new Error('No PDF selected')
const dataRoot = join(work, 'library')
await mkdir(dataRoot, { recursive: true })
const selected = new Set(candidates)
const attachments = source.attachments.filter((item) => selected.has(item.paperId) && ['pdf', 'translatedPDF'].includes(item.kind))
for (const attachment of attachments) {
  const relative = join('Library', attachment.paperId, attachment.filename)
  await mkdir(dirname(join(dataRoot, relative)), { recursive: true })
  await cp(join(sourceRoot, relative), join(dataRoot, relative))
}
await writeFile(join(dataRoot, 'library.json'), JSON.stringify({
  ...source, attachments, notes: [], readingStates: [], providers: [], models: [],
  settings: { ...source.settings, lastOpenedPaperId: scenarios[0].paperId, translationSetupNoticeHandled: true }
}))
const baseline = process.env.FREDDIE_BENCH_BASELINE_FILE
  ? await readFile(process.env.FREDDIE_BENCH_BASELINE_FILE, 'utf8')
  : execFileSync('git', ['show', '0341991ef4240908109790b14231402beea1d19d:src/readers/PdfView.tsx'], { encoding: 'utf8' })
await writeFile(join(work, 'baseline-PdfView.tsx'), baseline)
const baselineCSS = process.env.FREDDIE_BENCH_BASELINE_CSS
  ? await readFile(process.env.FREDDIE_BENCH_BASELINE_CSS, 'utf8')
  : execFileSync('git', ['show', '0341991ef4240908109790b14231402beea1d19d:src/styles/readers.css'], { encoding: 'utf8' })
await writeFile(join(work, 'baseline-readers.css'), baselineCSS)
await writeFile(join(work, 'baseline-base.css'), execFileSync('git', ['show', '0341991ef4240908109790b14231402beea1d19d:src/styles/base.css'], { encoding: 'utf8' }))
await writeFile(join(work, 'baseline-assistantHistory.ts'), execFileSync('git', ['show', '0341991ef4240908109790b14231402beea1d19d:src/readers/assistantHistory.ts'], { encoding: 'utf8' }))
await writeFile(join(work, 'baseline-pdfjs.ts'), execFileSync('git', ['show', '0341991ef4240908109790b14231402beea1d19d:src/readers/pdfjs.ts'], { encoding: 'utf8' }))
const rendererHashes = {}
for (const variant of ['baseline', 'optimized']) {
  console.log(`Building ${variant} production renderer`)
  const buildConfig = join(work, `${variant}.config.mjs`)
  await writeFile(buildConfig, `
    import config from ${JSON.stringify(pathToFileURL(join(root, 'electron.vite.config.ts')).href)};
    import {readFileSync} from 'node:fs';
    const renderer = {...config.renderer, plugins: [...config.renderer.plugins],
      build: {...config.renderer.build, outDir: ${JSON.stringify(join(work, variant))}, emptyOutDir: true}};
    ${variant === 'baseline' ? `renderer.plugins.unshift({name: 'benchmark-baseline-pdf', enforce: 'pre', load(id) {
      if (id === ${JSON.stringify(join(root, 'src/readers/PdfView.tsx'))}) return readFileSync(${JSON.stringify(join(work, 'baseline-PdfView.tsx'))}, 'utf8');
      if (id === ${JSON.stringify(join(root, 'src/styles/readers.css'))}) return readFileSync(${JSON.stringify(join(work, 'baseline-readers.css'))}, 'utf8');
      if (id === ${JSON.stringify(join(root, 'src/styles/base.css'))}) return readFileSync(${JSON.stringify(join(work, 'baseline-base.css'))}, 'utf8');
      if (id === ${JSON.stringify(join(root, 'src/readers/assistantHistory.ts'))}) return readFileSync(${JSON.stringify(join(work, 'baseline-assistantHistory.ts'))}, 'utf8');
      if (id === ${JSON.stringify(join(root, 'src/readers/pdfjs.ts'))}) return readFileSync(${JSON.stringify(join(work, 'baseline-pdfjs.ts'))}, 'utf8');
    }});` : ''}
    export default {...config, renderer};
  `)
  await build({ configFile: buildConfig, logLevel: 'warn' })
  await readFile(join(work, variant, 'index.html'))
  const scripts = (await readdir(join(work, variant, 'assets'))).filter((file) => file.endsWith('.js'))
  const hash = createHash('sha256')
  for (const script of scripts.sort()) hash.update(await readFile(join(work, variant, 'assets', script)))
  rendererHashes[variant] = hash.digest('hex')
}
if (rendererHashes.baseline === rendererHashes.optimized) throw new Error('Renderers are identical; refusing an invalid comparison')
const config = {
  root, work, dataRoot, scenarios, rendererHashes, profile: process.env.FREDDIE_BENCH_PROFILE === '1',
  startPage: Number(process.env.FREDDIE_BENCH_START_PAGE || 0),
  trace: process.env.FREDDIE_BENCH_TRACE === '1', onlyVariant: process.env.FREDDIE_BENCH_VARIANT,
  distance: Number(process.env.FREDDIE_BENCH_DISTANCE || 12000),
  speed: Number(process.env.FREDDIE_BENCH_SPEED || 2400),
  trials: Number(process.env.FREDDIE_BENCH_TRIALS || 3),
  variants: Object.fromEntries(['baseline', 'optimized'].map((variant) => [variant, pathToFileURL(join(work, variant, 'index.html')).href]))
}
const configPath = join(work, 'config.json')
await writeFile(configPath, JSON.stringify(config))
console.log(`Benchmark artifacts: ${work}`)
const environment = { ...process.env, FREDDIE_BENCH_CONFIG: configPath, FREDDIE_DATA_DIR: dataRoot }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.FREDDIE_IMPORT_NATIVE
const child = spawn(electron, [join(root, 'scripts/benchmark-pdf-electron.cjs')], { cwd: root, env: environment, stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
