// Stage parity against the Swift BabelDoc pipeline: the fixtures under
// tests/fixtures/babeldoc were dumped by the Swift harness against a
// -ffp-contract=off reference libmupdf, so frontend IL must match bit for bit
// and the TS stage ports must reproduce each later stage exactly on the fixed
// Swift layout detections.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractFrontend } from '../BabelDocKit/src/frontend'
import { babelDocWasm, type BabelDocWasmModule } from '../BabelDocKit/src/wasmModule'
import { LayoutParser } from '../BabelDocKit/src/layoutParser'
import { ParagraphFinder } from '../BabelDocKit/src/paragraphFinder'
import type { ILDocument } from '../BabelDocKit/src/il'
import type { PageLayoutResult } from '../BabelDocKit/src/layoutDetector'

const fixturesRoot = fileURLToPath(new URL('./fixtures/babeldoc', import.meta.url))

interface Fixture {
  name: string
  pdf: Uint8Array
  pages: number[] | null
  stage: (file: string) => unknown
  has: (file: string) => boolean
}

/** nil and an absent key are the same value in the IL (PythonOptional decodes
 * both to none); everything else must match exactly. */
function deepEqualIL(wasm: unknown, swift: unknown, path = '$'): string | null {
  if (wasm === undefined) wasm = null
  if (swift === undefined) swift = null
  if (Array.isArray(wasm) && Array.isArray(swift)) {
    if (wasm.length !== swift.length) return `${path}: array length ${wasm.length} vs ${swift.length}`
    for (let index = 0; index < wasm.length; index += 1) {
      const difference = deepEqualIL(wasm[index], swift[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return null
  }
  if (wasm !== null && swift !== null && typeof wasm === 'object' && typeof swift === 'object') {
    const keys = new Set([...Object.keys(wasm), ...Object.keys(swift)])
    for (const key of keys) {
      const difference = deepEqualIL((wasm as Record<string, unknown>)[key], (swift as Record<string, unknown>)[key], `${path}.${key}`)
      if (difference) return difference
    }
    return null
  }
  if (wasm !== swift && !(typeof wasm === 'number' && typeof swift === 'number' && Object.is(wasm, swift))) {
    return `${path}: ${JSON.stringify(wasm)} vs ${JSON.stringify(swift)}`
  }
  return null
}

let wasm: BabelDocWasmModule
const fixtures: Fixture[] = []

beforeAll(async () => {
  wasm = await babelDocWasm()
  for (const name of readdirSync(fixturesRoot).sort()) {
    const directory = join(fixturesRoot, name)
    if (!existsSync(join(directory, 'manifest.json'))) continue
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { pdf: string; pages: number[] | null }
    fixtures.push({
      name,
      pdf: new Uint8Array(readFileSync(join(fixturesRoot, manifest.pdf))),
      pages: manifest.pages,
      stage: (file) => JSON.parse(readFileSync(join(directory, file), 'utf8')),
      has: (file) => existsSync(join(directory, file))
    })
  }
  if (fixtures.length === 0) throw new Error('babeldoc parity fixtures are missing; run npm run sync:babeldoc -- --parity')
})

/** The fixture JSON encodes Swift Floats at shortest-roundtrip; restore the
 * exact Float32 values the Swift pipeline carried in memory. */
function reviveDetections(results: PageLayoutResult[]): PageLayoutResult[] {
  return results.map((result) => ({
    ...result,
    detections: result.detections.map((detection) => ({
      ...detection,
      confidence: Math.fround(detection.confidence),
      imageBox: {
        x0: Math.fround(detection.imageBox.x0), y0: Math.fround(detection.imageBox.y0),
        x1: Math.fround(detection.imageBox.x1), y1: Math.fround(detection.imageBox.y1)
      }
    }))
  }))
}

/** The frontend document both pipelines start from. */
async function frontendDocument(fixture: Fixture): Promise<ILDocument> {
  const extraction = await extractFrontend(fixture.pdf, fixture.pages ?? undefined, wasm)
  return extraction.document
}

describe('babeldoc stage parity', () => {
  it('frontend IL v1 matches the Swift reference exactly', async () => {
    for (const fixture of fixtures) {
      const document = await frontendDocument(fixture)
      const difference = deepEqualIL(document, fixture.stage('00-frontend.json'))
      expect(difference, `${fixture.name}: ${difference ?? ''}`).toBeNull()
    }
  })

  it('writeLayouts reproduces the Swift stage on the fixed Swift detections', async () => {
    for (const fixture of fixtures) {
      const document = await frontendDocument(fixture)
      const detections = reviveDetections(fixture.stage('01-layout-detections.json') as PageLayoutResult[])
      LayoutParser.writeLayouts(document, detections)
      const difference = deepEqualIL(document, fixture.stage('02-il-after-layout.json'))
      expect(difference, `${fixture.name}: ${difference ?? ''}`).toBeNull()
    }
  })

  it('appendFallbackLines reproduces the Swift stage exactly', async () => {
    for (const fixture of fixtures) {
      const document = await frontendDocument(fixture)
      LayoutParser.writeLayouts(document, reviveDetections(fixture.stage('01-layout-detections.json') as PageLayoutResult[]))
      for (const page of document.page ?? []) LayoutParser.appendFallbackLines(page)
      const difference = deepEqualIL(document, fixture.stage('03-il-after-fallback.json'))
      expect(difference, `${fixture.name}: ${difference ?? ''}`).toBeNull()
    }
  })

  it('ParagraphFinder reproduces the Swift stage exactly', async () => {
    for (const fixture of fixtures) {
      if (!fixture.has('04-il-after-paragraph.json')) continue
      const document = await frontendDocument(fixture)
      LayoutParser.writeLayouts(document, reviveDetections(fixture.stage('01-layout-detections.json') as PageLayoutResult[]))
      for (const page of document.page ?? []) LayoutParser.appendFallbackLines(page)
      ParagraphFinder.process(document)
      const difference = deepEqualIL(document, fixture.stage('04-il-after-paragraph.json'))
      expect(difference, `${fixture.name}: ${difference ?? ''}`).toBeNull()
    }
  })
})
