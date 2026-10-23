#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const RELEASE_TYPES = new Set(['major', 'minor', 'patch'])
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = join(rootDir, 'package.json')
const lockPath = join(rootDir, 'package-lock.json')

const usage = () => {
  console.log(`Usage: npm run bump_version -- <major|minor|patch|version>

Examples:
  npm run bump_version -- patch
  npm run bump_version -- minor
  npm run bump_version -- 1.2.0
  npm run bump_version -- v1.2.0`)
}

const fail = (message) => {
  console.error(`bump_version: ${message}`)
  process.exit(1)
}

const git = (args, options = {}) => execFileSync('git', args, {
  cwd: rootDir,
  encoding: 'utf8',
  ...options
})

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const parseVersion = (value, label) => {
  const match = SEMVER.exec(value)
  if (!match) fail(`${label} is not a valid semantic version: ${value}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

const resolveVersion = (current, requested) => {
  const parsed = parseVersion(current, 'current package version')
  if (RELEASE_TYPES.has(requested)) {
    if (requested === 'major') return `${parsed.major + 1}.0.0`
    if (requested === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  }

  const exact = requested.startsWith('v') ? requested.slice(1) : requested
  parseVersion(exact, 'requested version')
  return exact
}

const writeJsonAtomically = (path, value) => {
  const temporaryPath = `${path}.bump-version-${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: statSync(path).mode
    })
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  usage()
  process.exit(0)
}
if (args.length !== 1) {
  usage()
  fail('provide exactly one release type or version')
}

const manifest = readJson(packagePath)
const lockfile = readJson(lockPath)
const currentVersion = manifest.version

if (typeof currentVersion !== 'string') fail('package.json has no string version field')
if (lockfile.version !== currentVersion || lockfile.packages?.['']?.version !== currentVersion) {
  fail('package.json and package-lock.json versions are not in sync')
}

const nextVersion = resolveVersion(currentVersion, args[0])
if (nextVersion === currentVersion) fail(`version is already ${currentVersion}`)

let versionFileStatus
try {
  versionFileStatus = git([
    'status', '--porcelain', '--untracked-files=no', '--', 'package.json', 'package-lock.json'
  ]).trim()
} catch (error) {
  fail(`cannot inspect the Git worktree: ${error instanceof Error ? error.message : String(error)}`)
}
if (versionFileStatus) {
  fail('package.json or package-lock.json already has uncommitted changes')
}

const tag = `v${nextVersion}`
const tagCheck = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
  cwd: rootDir
})
if (tagCheck.error) fail(`cannot inspect Git tags: ${tagCheck.error.message}`)
if (tagCheck.status === 0) fail(`tag ${tag} already exists locally`)
if (tagCheck.status !== 1) fail(`cannot inspect whether tag ${tag} exists`)

manifest.version = nextVersion
lockfile.version = nextVersion
lockfile.packages[''].version = nextVersion

writeJsonAtomically(packagePath, manifest)
writeJsonAtomically(lockPath, lockfile)

console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`)
try {
  git([
    'commit', '--only', '-m', `[chore]: bump version to ${nextVersion}`,
    '--', 'package.json', 'package-lock.json'
  ], { stdio: 'inherit' })
} catch {
  fail('version files were updated, but the Git commit failed')
}

const commit = git(['rev-parse', '--short', 'HEAD']).trim()
console.log(`Committed version bump as ${commit}.`)
console.log('\nCreate and push the release tag with:')
console.log(`  git tag ${tag}`)
console.log('  git push origin HEAD')
console.log(`  git push origin ${tag}`)
