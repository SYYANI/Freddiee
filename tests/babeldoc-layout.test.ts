// Layout-detection parity: the TS pipeline (wasm MuPDF render → preprocessing →
// onnxruntime-node) against the Swift Core ML detections the fixtures pin. The
// two models are the same weights through different backends, so the final
// boxes compare by IoU ≥ 0.95, equal class and |Δconfidence| ≤ 0.02 — the
// thresholds recorded in BabelDocKit/README.md. Downstream stage parity instead
// feeds the Swift detections in as a fixed input (babeldoc-parity.test.ts).
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { babelDocWasm, type BabelDocWasmModule } from '../BabelDocKit/src/wasmModule'
import { loadPDFPages } from '../BabelDocKit/src/documentLoader'
import { LayoutDetector, type LayoutDetection, type PageLayoutResult } from '../BabelDocKit/src/layoutDetector'
import { runtimeManifest } from '../BabelDocKit/src/runtime'

const fixturesRoot = fileURLToPath(new URL('./fixtures/babeldoc', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const modelPath = join(repoRoot, 'BabelDocKit', 'runtime', runtimeManifest.layoutModel.file)

function iou(a: LayoutDetection['imageBox'], b: LayoutDetection['imageBox']): number {
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0)
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)
  const union = areaA + areaB - intersection
  return union <= 0 ? 0 : intersection / union
}

describe('babeldoc layout detection parity', () => {
  beforeAll(() => {
    if (!existsSync(modelPath)) {
      console.warn(`skipping: ${modelPath} is missing; run npm run sync:babeldoc`)
    }
  })

  it('matches the Swift Core ML detections within the recorded thresholds', { timeout: 240_000 }, async () => {
    if (!existsSync(modelPath)) return
    const wasm: BabelDocWasmModule = await babelDocWasm()
    const detector = new LayoutDetector({ modelPath })

    for (const name of ['paper-p1', 'content-types', 'image-xobject-smoke']) {
      const directory = join(fixturesRoot, name)
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { pdf: string; pages: number[] | null }
      const swiftResults = JSON.parse(readFileSync(join(directory, '01-layout-detections.json'), 'utf8')) as PageLayoutResult[]
      const pdf = new Uint8Array(readFileSync(join(fixturesRoot, manifest.pdf)))
      const loaded = await loadPDFPages(pdf, null, wasm)
      const pages = manifest.pages
        ? manifest.pages.map((pageNumber) => loaded.pages.find((page) => page.sourcePageNumber === pageNumber)).filter((page) => page !== undefined)
        : loaded.pages

      for (const [index, page] of pages.entries()) {
        const ours = await detector.detect(page)
        const swift = swiftResults[index]?.detections ?? []
        const used = new Set<number>()
        for (const detection of ours.detections) {
          let best = -1
          let bestIoU = 0
          for (let candidate = 0; candidate < swift.length; candidate += 1) {
            if (used.has(candidate)) continue
            const value = iou(detection.imageBox, swift[candidate].imageBox)
            if (value > bestIoU) { bestIoU = value; best = candidate }
          }
          if (best < 0 || bestIoU < 0.5) {
            expect.fail(`${name} page ${page.sourcePageNumber}: unmatched detection ${detection.className} (${detection.confidence.toFixed(3)})`)
          }
          used.add(best)
          const reference = swift[best]
          expect(bestIoU, `${name} page ${page.sourcePageNumber}: IoU for ${detection.className}`).toBeGreaterThanOrEqual(0.95)
          expect(detection.classIndex, `${name} page ${page.sourcePageNumber}: class`).toBe(reference.classIndex)
          expect(Math.abs(detection.confidence - reference.confidence),
            `${name} page ${page.sourcePageNumber}: confidence for ${detection.className}`).toBeLessThanOrEqual(0.02)
        }
        expect(ours.detections.length, `${name} page ${page.sourcePageNumber}: detection count`)
          .toBe(swift.length)
      }
    }
  })
})
