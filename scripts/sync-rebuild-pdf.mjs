// Copies the upstream-owned material of RebuildPDFKit from a rebuild-pdf checkout:
// the model prompts (byte for byte), the PyMuPDF line metrics, and the parity fixtures
// the Swift package checks against. The TypeScript port lives in RebuildPDFKit/src.
//
// Usage: node scripts/sync-rebuild-pdf.mjs [/path/to/rebuild-pdf]
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const upstream = resolve(process.argv[2] ?? '../rebuild-pdf')
const kit = join(upstream, 'Sources', 'RebuildPDFKit')
const resources = resolve('RebuildPDFKit', 'resources')
const fixtures = resolve('tests', 'fixtures', 'rebuild-pdf')

mkdirSync(join(resources, 'prompts'), { recursive: true })
mkdirSync(join(fixtures, 'images'), { recursive: true })
for (const name of ['transcribe', 'review', 'translate-zh']) {
  copyFileSync(join(kit, 'Resources', 'Prompts', `${name}.txt`), join(resources, 'prompts', `${name}.txt`))
}
// Bundled as text so the main-process build and the tests read it the same way.
const metrics = readFileSync(join(kit, 'Resources', 'line-metrics.bin'))
writeFileSync(join(resources, 'line-metrics.bin.b64'), `${metrics.toString('base64')}\n`)

const tests = join(upstream, 'tests', 'RebuildPDFKitTests', 'Fixtures')
for (const name of ['parity.json', 'thompson-transcriptions.json']) copyFileSync(join(tests, name), join(fixtures, name))
for (const image of readdirSync(join(tests, 'images'))) {
  copyFileSync(join(tests, 'images', image), join(fixtures, 'images', image))
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  // Not a git checkout.
}
writeFileSync(join(resources, 'UPSTREAM.json'), `${JSON.stringify({ repository: 'rebuild-pdf', commit }, null, 2)}\n`)
console.log(`Synchronized RebuildPDFKit resources from ${upstream} (${commit})`)
