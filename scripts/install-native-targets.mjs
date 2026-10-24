// npm only installs optional native binaries matching the host. Fetch the
// binaries for a cross-built target platform/arch into node_modules, without
// touching package.json or the lockfile, so electron-builder bundles them.
//
// onnxruntime-node is different: one package tarball carries the binaries for
// every platform, so instead of fetching we restore the target's directory from
// the tarball when a previous package build pruned it, then prune every other
// platform so installers do not ship all six (~290 MB) native sets.
//
// Usage: node scripts/install-native-targets.mjs <platform> <arch>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NATIVE_PARENTS = ['@napi-rs/canvas', 'koffi']

const [platform, arch] = process.argv.slice(2)
if (!platform || !arch) {
  console.error('Usage: node scripts/install-native-targets.mjs <platform> <arch>')
  process.exit(1)
}

const modulesDir = join(process.cwd(), 'node_modules')
const readManifest = (name) => {
  const file = join(modulesDir, name, 'package.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
// Prefer the glibc build on Linux, matching what npm picks on a glibc host.
const targetPattern = new RegExp(`-${platform}-${arch}(-|$)`)
const targetPackages = NATIVE_PARENTS.flatMap((parent) => {
  const manifest = readManifest(parent)
  if (!manifest) throw new Error(`${parent} is not installed; run npm install first`)
  const matches = Object.entries(manifest.optionalDependencies ?? {}).filter(
    ([name]) => targetPattern.test(name) && !name.includes('musl')
  )
  if (matches.length !== 1) {
    throw new Error(`Expected one ${platform}-${arch} binary for ${parent}, found ${matches.length}`)
  }
  return matches
})

const runNpm = (args, cwd) => {
  // Inside an npm script npm_execpath points at npm's JS entry, which avoids
  // resolving npm.cmd through a shell on Windows.
  const npmCli = process.env.npm_execpath
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' })
    : execFileSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
}

for (const [name, version] of targetPackages) {
  if (readManifest(name)?.version === version) {
    console.log(`${name}@${version} already present`)
    continue
  }

  const workDir = mkdtempSync(join(tmpdir(), 'freddie-native-'))
  try {
    runNpm(['pack', `${name}@${version}`, '--pack-destination', workDir, '--silent'], workDir)
    const tarball = readdirSync(workDir).find((file) => file.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for ${name}@${version}`)

    const target = join(modulesDir, name)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    execFileSync('tar', ['-xzf', join(workDir, tarball), '-C', target, '--strip-components=1'])
    console.log(`Installed ${name}@${version} for ${platform}-${arch}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// onnxruntime-node: restore this target's binaries if a previous package build
// pruned them, then remove every other platform so only one native set ships.
const ORT = 'onnxruntime-node'
const ortVersion = readManifest(ORT)?.version
if (!ortVersion) throw new Error(`${ORT} is not installed; run npm install first`)
const ortBin = join(modulesDir, ORT, 'bin', 'napi-v6')
const ortTarget = join(ortBin, platform, arch)
if (!existsSync(ortTarget)) {
  const workDir = mkdtempSync(join(tmpdir(), 'freddie-native-'))
  try {
    runNpm(['pack', `${ORT}@${ortVersion}`, '--pack-destination', workDir, '--silent'], workDir)
    const tarball = readdirSync(workDir).find((file) => file.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for ${ORT}@${ortVersion}`)
    mkdirSync(ortTarget, { recursive: true })
    execFileSync('tar', ['-xzf', join(workDir, tarball), '-C', ortTarget, '--strip-components=5', `package/bin/napi-v6/${platform}/${arch}`])
    console.log(`Restored ${ORT}@${ortVersion} binaries for ${platform}-${arch}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
let pruned = 0
for (const osName of readdirSync(ortBin)) {
  const osDir = join(ortBin, osName)
  if (osName !== platform) {
    rmSync(osDir, { recursive: true, force: true })
    pruned += 1
    continue
  }
  for (const archName of readdirSync(osDir)) {
    if (archName !== arch) {
      rmSync(join(osDir, archName), { recursive: true, force: true })
      pruned += 1
    }
  }
}
console.log(`${ORT}@${ortVersion}: kept ${platform}/${arch}, pruned ${pruned} other platform directories`)
