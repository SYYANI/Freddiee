import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { babelDocWasm, createPipeline, defaultBackendConfiguration, extractFrontend, fontDirectory, layoutModelPath, NativePDFBackend } from '../BabelDocKit'

async function sharedFormPDF(nested: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const form = pdf.context.register(pdf.context.flateStream('BT /F1 12 Tf 50 700 Td (shared source text) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { Font: { F1: font.ref } }
  }))
  const outer = nested ? pdf.context.register(pdf.context.flateStream('/Inner Do', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { XObject: { Inner: form } }
  })) : form
  const resources = pdf.context.register(pdf.context.obj({ XObject: { Shared: form } }))
  const nestedResources = pdf.context.register(pdf.context.obj({ XObject: { Shared: outer } }))
  for (let index = 0; index < 3; index += 1) {
    const page = pdf.addPage([612, 792])
    page.node.set(PDFName.of('Resources'), nested && index === 1 ? nestedResources : resources)
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream('/Shared Do')))
  }
  return pdf.save()
}

describe('BabelDOC page resource isolation', () => {
  it.each([
    { nested: false, mode: 'rebuild' as const },
    { nested: true, mode: 'rebuild' as const },
    // A missing source plan follows the same rebuild fallback used on failures.
    { nested: true, mode: 'source-preserving' as const }
  ])('keeps unselected pages intact: $mode, nested=$nested', async ({ nested, mode }) => {
    const pdf = await sharedFormPDF(nested)
    const { document } = await extractFrontend(pdf, [1, 3])
    const replacements = ['FIRST PAGE CONTENT', 'THIRD PAGE CONTENT']
    for (const [index, page] of document.page!.entries()) {
      page.pdf_character!.forEach((character, offset) => {
        character.char_unicode = replacements[index][offset]
        character.pdf_character_id = replacements[index].codePointAt(offset)
      })
    }
    const translated = structuredClone(document)
    const output = await NativePDFBackend.write(pdf, document, {
      ...defaultBackendConfiguration, renderingMode: mode, onlyIncludeTranslatedPages: false
    })
    expect(document).toEqual(translated) // Cached/source IL keeps its original xrefs.
    const actual = await extractFrontend(output.pdf)
    expect(actual.document.page?.map((page) => page.pdf_character?.map((character) => character.char_unicode).join('')))
      .toEqual([replacements[0], 'shared source text', replacements[1]])
    const wasm = await babelDocWasm()
    expect(Buffer.from(wasm.renderPDFPage(output.pdf, 1).rgb).equals(wasm.renderPDFPage(pdf, 1).rgb)).toBe(true)
  })

  it.each(['rebuild', 'source-preserving'] as const)('preserves other pages through the full %s pipeline', { timeout: 30_000 }, async (renderingMode) => {
    const pdf = await sharedFormPDF(false)
    const pipeline = createPipeline(pdf, [1], {
      layoutModelPath: layoutModelPath(), targetFontDirectory: fontDirectory(),
      targetLanguage: 'zh-CN', renderingMode, onlyIncludeTranslatedPages: false
    })
    const output = await pipeline.translatePDF({
      maximumConcurrentTranslations: 1,
      formulaPlaceholder: (id) => `[BABELDOC_FORMULA_${id}]`,
      translate: async () => '共享原文的中文翻译'
    })
    expect(output.diagnostics.translationReport.translatedCount).toBe(1)
    const actual = await extractFrontend(output.pdf)
    expect(actual.document.page?.map((page) => page.pdf_character?.map((character) => character.char_unicode).join('')))
      .toEqual(['共享原文的中文翻译', 'shared source text', 'shared source text'])
    const wasm = await babelDocWasm()
    for (const index of [1, 2]) {
      expect(Buffer.from(wasm.renderPDFPage(output.pdf, index).rgb).equals(wasm.renderPDFPage(pdf, index).rgb)).toBe(true)
    }
  })
})
