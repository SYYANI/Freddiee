import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPipeline, fontDirectory, LayoutDetector, layoutModelPath } from '../BabelDocKit'

async function threePagePDF(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= 3; page += 1) {
    pdf.addPage([612, 792]).drawText(`source page ${page}`, { x: 50, y: 700, size: 12, font })
  }
  return pdf.save()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BabelDOC pipeline cancellation', () => {
  it('stops layout detection at the next page once aborted mid-inference', { timeout: 30_000 }, async () => {
    const controller = new AbortController()
    const detect = LayoutDetector.prototype.detect
    // Abort while the first page's inference is in flight, as the worker does
    // when cancellation arrives during session.run().
    const spy = vi.spyOn(LayoutDetector.prototype, 'detect').mockImplementation(async function (this: LayoutDetector, page) {
      const running = detect.call(this, page)
      controller.abort(new DOMException('Translation cancelled', 'AbortError'))
      return running
    })
    const translate = vi.fn(async (text: string) => text)
    const pipeline = createPipeline(await threePagePDF(), null, {
      layoutModelPath: layoutModelPath(), targetFontDirectory: fontDirectory(),
      targetLanguage: 'zh-CN', renderingMode: 'rebuild', onlyIncludeTranslatedPages: false
    }, controller.signal)
    await expect(pipeline.translatePDF({
      maximumConcurrentTranslations: 1,
      formulaPlaceholder: (id) => `[BABELDOC_FORMULA_${id}]`,
      translate
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spy).toHaveBeenCalledOnce()
    expect(translate).not.toHaveBeenCalled()
  })
})
