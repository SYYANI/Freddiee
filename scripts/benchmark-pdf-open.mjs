// Run with a GUI session: FREDDIE_BENCH_PAPERS=<id>:<pdf|bilingualPDF>[:startPage],... node scripts/benchmark-pdf-open.mjs
// Cold open and scroll of the current production build. Each trial is a new app process that opens
// the paper directly; real PDFs are copied into an isolated temporary library. The source library is read-only.
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'electron-vite'
import electron from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const work = process.env.FREDDIE_BENCH_DIR || await mkdtemp(join(tmpdir(), 'freddie-pdf-open-'))
await mkdir(work, { recursive: true })
const sourceRoot = process.env.FREDDIE_BENCH_LIBRARY || join(homedir(), 'Library/Application Support/Freddie')
const source = JSON.parse(await readFile(join(sourceRoot, 'library.json'), 'utf8'))
if (!process.env.FREDDIE_BENCH_PAPERS) throw new Error('Set FREDDIE_BENCH_PAPERS=<paper id>:<pdf|bilingualPDF>[:start page],...')
const scenarios = process.env.FREDDIE_BENCH_PAPERS.split(',').map((entry) => {
  const [paperId, mode = 'pdf', startPage = '0'] = entry.split(':')
  return { paperId, mode, startPage: Number(startPage), title: source.papers.find((paper) => paper.id === paperId)?.title?.slice(0, 40) }
})
console.log('Building production app')
await build({ logLevel: 'warn' })
const dataRoot = join(work, 'library')
await mkdir(dataRoot, { recursive: true })
const selected = new Set(scenarios.map((scenario) => scenario.paperId))
const attachments = source.attachments.filter((item) => selected.has(item.paperId) && ['pdf', 'translatedPDF'].includes(item.kind))
for (const attachment of attachments) {
  const relative = join('Library', attachment.paperId, attachment.filename)
  await mkdir(dirname(join(dataRoot, relative)), { recursive: true })
  await cp(join(sourceRoot, relative), join(dataRoot, relative))
}
const trials = Number(process.env.FREDDIE_BENCH_TRIALS || 3)
const results = []
console.log(`Benchmark artifacts: ${work}`)
for (const scenario of scenarios) {
  for (let trial = 1; trial <= trials; trial++) {
    await writeFile(join(dataRoot, 'library.json'), JSON.stringify({
      ...source, attachments, notes: [], providers: [], models: [],
      readingStates: [{ paperId: scenario.paperId, readerMode: scenario.mode, pageIndex: scenario.startPage, scrollRatio: 0, zoomScale: 1, modifiedAt: new Date().toISOString() }],
      settings: { ...source.settings, lastOpenedPaperId: scenario.paperId, translationSetupNoticeHandled: true }
    }))
    const configPath = join(work, 'config.json')
    await writeFile(configPath, JSON.stringify({
      root, work, scenario, trial,
      renderer: pathToFileURL(join(root, 'out/renderer/index.html')).href,
      speeds: (process.env.FREDDIE_BENCH_SPEEDS || '1500,4000').split(',').map(Number),
      distance: Number(process.env.FREDDIE_BENCH_DISTANCE || 6000),
      // Answers raster requests with 503, measuring the browser fallback renderer instead.
      noWorker: process.env.FREDDIE_BENCH_NO_WORKER === '1',
      width: Number(process.env.FREDDIE_BENCH_WIDTH || 1400), height: Number(process.env.FREDDIE_BENCH_HEIGHT || 860)
    }))
    const environment = { ...process.env, FREDDIE_BENCH_CONFIG: configPath, FREDDIE_DATA_DIR: dataRoot }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.FREDDIE_IMPORT_NATIVE
    const code = await new Promise((done) => {
      const child = spawn(electron, [join(root, 'scripts/benchmark-pdf-open-electron.cjs')], { cwd: root, env: environment, stdio: 'inherit' })
      const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
      child.on('exit', (exitCode) => { clearTimeout(timer); done(exitCode) })
    })
    if (code !== 0) throw new Error(`Trial ${trial} of ${scenario.paperId} failed (${code}); see ${join(work, 'failure.txt')}`)
    results.push(JSON.parse(await readFile(join(work, 'result.json'), 'utf8')))
    await writeFile(join(work, 'results.json'), JSON.stringify(results, null, 2))
  }
}
console.log(`Completed. Results: ${join(work, 'results.json')}`)
