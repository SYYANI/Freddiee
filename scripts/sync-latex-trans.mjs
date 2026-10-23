// Regenerates LaTeXTransKit's upstream-derived material from a LaTeXTransSwift (arxivLatex)
// checkout: the parity fixtures recorded from the Swift kit, the Unicode property tables the
// Swift Character predicates use, and, with --corpus, the stage hashes of real arXiv sources.
// The generator is the Swift package in scripts/latex-trans-parity; it needs macOS and Swift.
//
// Usage: node scripts/sync-latex-trans.mjs [/path/to/arxivLatex] [--corpus /path/to/ReadPaper/Library]
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const corpusIndex = args.indexOf('--corpus')
const corpus = corpusIndex >= 0 ? resolve(args[corpusIndex + 1]) : undefined
const upstream = resolve(args.find((value, index) => !value.startsWith('--') && index !== corpusIndex + 1) ?? '../arxivLatex')
const generator = resolve('scripts', 'latex-trans-parity')
const environment = {
  ...process.env,
  LATEXTRANS_SWIFT: upstream,
  SWIFTPM_MODULECACHE_OVERRIDE: join(generator, '.build', 'module-cache'),
  CLANG_MODULE_CACHE_PATH: join(generator, '.build', 'clang-module-cache')
}

execFileSync('swift', ['build', '--disable-sandbox', '-c', 'release', '--package-path', generator], { stdio: 'inherit', env: environment })
// Glossary order follows the locale (`localizedCaseInsensitiveCompare`); the tests use en-US.
execFileSync(join(generator, '.build', 'release', 'latextrans-parity'), [
  resolve('tests', 'fixtures', 'latex-trans'),
  resolve('LaTeXTransKit', 'resources'),
  ...(corpus ? ['--corpus', corpus] : []),
  '-AppleLocale', 'en_US', '-AppleLanguages', '(en)'
], { stdio: 'inherit', env: environment })

let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  // Not a git checkout.
}
writeFileSync(resolve('LaTeXTransKit', 'resources', 'UPSTREAM.json'), `${JSON.stringify({ repository: 'LaTeXTransSwift (arxivLatex)', commit, host: 'read-paper ReadPaper/Services/LaTeXTranslationService.swift' }, null, 2)}\n`)
console.log(`Synchronized LaTeXTransKit fixtures from ${upstream} (${commit})`)
