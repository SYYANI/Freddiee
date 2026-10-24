// Validates BabelDocKit/runtime against the committed runtime manifest before
// any package:* build. A missing model, a modified font or any extra file fails
// the build instead of silently shipping a degraded installer.
//
// Usage: node scripts/verify-babeldoc-runtime.mjs
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeRuntimeIssues, validateRuntimeDirectory } from '../BabelDocKit/src/runtimeValidate.ts'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const manifest = JSON.parse(readFileSync(join(repo, 'BabelDocKit', 'resources', 'runtime-manifest.json'), 'utf8'))
const verification = validateRuntimeDirectory(join(repo, 'BabelDocKit', 'runtime'), manifest)

if (!verification.valid) {
  console.error('The BabelDocKit runtime is incomplete or modified; run `npm run sync:babeldoc` first.')
  console.error(describeRuntimeIssues(verification))
  process.exit(1)
}
console.log(`babeldoc runtime verified: ${verification.verifiedFiles.length} pinned files match the manifest.`)
