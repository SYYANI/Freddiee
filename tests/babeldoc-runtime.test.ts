import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runtimeManifest, verifyBabelDocRuntime } from '../BabelDocKit/src/runtime'
import { describeRuntimeIssues, validateRuntimeDirectory, type RuntimeManifest } from '../BabelDocKit/src/runtimeValidate'

const root = join(tmpdir(), 'babeldoc-runtime-test')

function writeRuntime(manifest: RuntimeManifest, directory: string = root): void {
  rmSync(directory, { recursive: true, force: true })
  for (const asset of [manifest.layoutModel, ...manifest.fonts.files]) {
    const target = join(directory, asset.file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, Buffer.alloc(asset.size, 7))
  }
}

const smallManifest: RuntimeManifest = {
  schemaVersion: 1,
  kind: 'babeldoc-runtime-v1',
  layoutModel: {
    file: 'models/model.onnx', sha256: 'a'.repeat(64), size: 4, url: '', huggingFaceRepository: '', convertedFrom: '', license: ''
  },
  fonts: {
    source: 'test',
    files: [
      { file: 'fonts/Font-Regular.ttf', sha256: 'b'.repeat(64), size: 3 },
      { file: 'fonts/licenses/Font-OFL-1.1.txt', sha256: 'c'.repeat(64), size: 2 }
    ]
  }
}

// Point the placeholder hashes at the bytes the Buffer.alloc(7) fixtures write.
function hashOfByte(byte: number, count: number): string {
  return createHash('sha256').update(Buffer.alloc(count, byte)).digest('hex')
}

describe('babeldoc runtime validation', () => {
  beforeAll(() => {
    smallManifest.layoutModel.sha256 = hashOfByte(7, 4)
    smallManifest.fonts.files[0].sha256 = hashOfByte(7, 3)
    smallManifest.fonts.files[1].sha256 = hashOfByte(7, 2)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('accepts a runtime directory that matches the pinned manifest', () => {
    writeRuntime(smallManifest)
    const verification = validateRuntimeDirectory(root, smallManifest)
    expect(verification.issues).toEqual([])
    expect(verification.valid).toBe(true)
    expect(verification.verifiedFiles).toContain('models/model.onnx')
    expect(verification.verifiedFiles).toContain('fonts/licenses/Font-OFL-1.1.txt')
  })

  it('rejects a missing file, a wrong size and a wrong hash', () => {
    writeRuntime(smallManifest)
    rmSync(join(root, 'fonts', 'Font-Regular.ttf'))
    const missing = validateRuntimeDirectory(root, smallManifest)
    expect(missing.valid).toBe(false)
    expect(missing.issues.some((issue) => issue.file === 'fonts/Font-Regular.ttf' && issue.problem === 'missing')).toBe(true)

    writeRuntime(smallManifest)
    writeFileSync(join(root, 'models', 'model.onnx'), Buffer.alloc(9, 7))
    const sized = validateRuntimeDirectory(root, smallManifest)
    expect(sized.issues.some((issue) => issue.file === 'models/model.onnx' && issue.problem === 'size-mismatch')).toBe(true)

    writeRuntime(smallManifest)
    writeFileSync(join(root, 'fonts', 'licenses', 'Font-OFL-1.1.txt'), Buffer.alloc(2, 3))
    const hashed = validateRuntimeDirectory(root, smallManifest)
    expect(hashed.issues.some((issue) => issue.file === 'fonts/licenses/Font-OFL-1.1.txt' && issue.problem === 'hash-mismatch')).toBe(true)
  })

  it('rejects unexpected files and symbolic links', () => {
    writeRuntime(smallManifest)
    writeFileSync(join(root, 'fonts', 'extra.ttf'), Buffer.alloc(3, 7))
    const extra = validateRuntimeDirectory(root, smallManifest)
    expect(extra.issues.some((issue) => issue.file === 'fonts/extra.ttf' && issue.problem === 'unexpected-file')).toBe(true)

    writeRuntime(smallManifest)
    const link = join(root, 'models', 'model-link.onnx')
    try {
      symlinkSync(join(root, 'models', 'model.onnx'), link)
    } catch {
      return // Symbolic links need privileges on some Windows setups.
    }
    const linked = validateRuntimeDirectory(root, smallManifest)
    expect(linked.valid).toBe(false)
    expect(linked.issues.some((issue) => issue.file === 'models/model-link.onnx' && issue.problem === 'symlink')).toBe(true)
  })

  it('rejects a symlinked manifest file and a malformed manifest', () => {
    writeRuntime(smallManifest)
    rmSync(join(root, 'models', 'model.onnx'))
    try {
      symlinkSync('/nonexistent-model.onnx', join(root, 'models', 'model.onnx'))
    } catch {
      return
    }
    const linked = validateRuntimeDirectory(root, smallManifest)
    expect(linked.issues.some((issue) => issue.file === 'models/model.onnx' && issue.problem === 'symlink')).toBe(true)

    const malformed = validateRuntimeDirectory(root, { ...smallManifest, schemaVersion: 2 })
    expect(malformed.valid).toBe(false)
  })

  it('describes hash failures in a clear multi-line report', () => {
    writeRuntime(smallManifest)
    writeFileSync(join(root, 'models', 'model.onnx'), Buffer.alloc(4, 1))
    const verification = validateRuntimeDirectory(root, smallManifest)
    expect(describeRuntimeIssues(verification)).toMatch(/SHA-256 does not match the pinned/)
    expect(() => verifyBabelDocRuntime(root)).toThrow(/incomplete or modified/)
  })

  it('has a committed manifest with 20 pinned files and no local-root dependency', () => {
    expect([runtimeManifest.layoutModel, ...runtimeManifest.fonts.files]).toHaveLength(20)
    expect(runtimeManifest.layoutModel.license).toBe('apache-2.0')
    expect(runtimeManifest.schemaVersion).toBe(1)
  })
})
