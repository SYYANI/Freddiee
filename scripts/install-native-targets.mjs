// npm only installs optional native binaries matching the host. Fetch the
// binaries for a cross-built target platform/arch into node_modules, without
// touching package.json or the lockfile, so electron-builder bundles them.
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
