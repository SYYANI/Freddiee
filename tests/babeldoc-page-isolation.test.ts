import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'
import { babelDocWasm, createPipeline, defaultBackendConfiguration, extractFrontend, fontDirectory, layoutModelPath, NativePDFBackend } from '../BabelDocKit'
import type { ILDocument } from '../BabelDocKit/src/il'
import { isolateSharedPageStreams } from '../BabelDocKit/src/pdfPageIsolation'

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

/** The widget annotation paints the shared form, so isolating its page clones
 * the annotation — and the AcroForm reference has to follow it. `inline` writes
 * the widget directly into /Annots, as non-conforming producers do. */
async function sharedFormWithWidgetPDF(inline = false): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const form = pdf.context.register(pdf.context.flateStream('BT /F1 12 Tf 50 700 Td (shared source text) Tj ET', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { Font: { F1: font.ref } }
  }))
  const resources = pdf.context.register(pdf.context.obj({ XObject: { Shared: form } }))
  for (let index = 0; index < 3; index += 1) {
    const page = pdf.addPage([612, 792])
    page.node.set(PDFName.of('Resources'), resources)
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream('/Shared Do')))
  }
  const widget = pdf.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: 'SharedField', Rect: [40, 40, 200, 80], AP: { N: form }
  })
  if (inline) {
    pdf.getPages()[0].node.set(PDFName.of('Annots'), pdf.context.obj([widget]))
    return pdf.save()
  }
  const field = pdf.context.register(widget)
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [field] }))
  pdf.getPages()[0].node.set(PDFName.of('Annots'), pdf.context.obj([field]))
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

  it('skips isolation for an encrypted PDF instead of failing the backend', async () => {
    const pdf = await sharedFormPDF(false)
    const { document } = await extractFrontend(pdf, [1, 3])
    const replacements = ['FIRST PAGE CONTENT', 'THIRD PAGE CONTENT']
    for (const [index, page] of document.page!.entries()) {
      page.pdf_character!.forEach((character, offset) => {
        character.char_unicode = replacements[index][offset]
        character.pdf_character_id = replacements[index].codePointAt(offset)
      })
    }
    // MuPDF opens permission-protected files with an empty password, but
    // pdf-lib cannot clone their streams; the backend must fall back to the
    // pre-isolation order rather than throwing after the LLM calls. The
    // selected pages still translate; only shared-stream overwrite protection
    // is lost, which is the acceptable price for producing anything at all.
    const load = vi.spyOn(PDFDocument, 'load').mockResolvedValue({ isEncrypted: true } as PDFDocument)
    try {
      const output = await NativePDFBackend.write(pdf, document, {
        ...defaultBackendConfiguration, renderingMode: 'rebuild', onlyIncludeTranslatedPages: false
      })
      const actual = await extractFrontend(output.pdf)
      const textOf = (page: NonNullable<ILDocument['page']>[number]): string => page.pdf_character?.map((character) => character.char_unicode).join('') ?? ''
      expect(actual.document.page).toHaveLength(3)
      expect(textOf(actual.document.page![0])).toBe(replacements[0])
      expect(textOf(actual.document.page![2])).toBe(replacements[1])
    } finally {
      load.mockRestore()
    }
  })

  it('repoints AcroForm fields at the cloned widget annotation', async () => {
    const pdf = await sharedFormWithWidgetPDF()
    const { document } = await extractFrontend(pdf, [1, 3])
    const { pdf: isolated } = await isolateSharedPageStreams(pdf, document)
    const saved = await PDFDocument.load(isolated)
    const original = await PDFDocument.load(pdf)
    const annots = saved.getPages()[0].node.Annots()!.asArray()
    const originalAnnots = original.getPages()[0].node.Annots()!.asArray()
    expect(annots).toHaveLength(1)
    const cloneRef = annots[0]
    const originalRef = originalAnnots[0]
    if (!(cloneRef instanceof PDFRef) || !(originalRef instanceof PDFRef)) throw new Error('annotation references missing')
    expect(cloneRef.objectNumber).not.toBe(originalRef.objectNumber)

    const acroForm = saved.context.lookup(saved.catalog.get(PDFName.of('AcroForm')))
    if (!(acroForm instanceof PDFDict)) throw new Error('AcroForm missing from the translated PDF')
    const fields = acroForm.get(PDFName.of('Fields'))
    if (!(fields instanceof PDFArray)) throw new Error('AcroForm fields missing from the translated PDF')
    expect(fields.asArray()).toEqual([cloneRef])
    const widget = saved.context.lookup(cloneRef)
    if (!(widget instanceof PDFDict)) throw new Error('cloned widget missing from the translated PDF')
    expect(widget.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Widget'))
    expect(widget.get(PDFName.of('T'))).toEqual(PDFName.of('SharedField'))
    // The clone paints its own copy of the shared stream, not the original.
    const originalWidget = original.context.lookup(originalRef)
    if (!(originalWidget instanceof PDFDict)) throw new Error('original widget missing')
    const appearance = widget.get(PDFName.of('AP'))
    const originalAppearance = originalWidget.get(PDFName.of('AP'))
    if (!(appearance instanceof PDFDict) || !(originalAppearance instanceof PDFDict)) throw new Error('widget appearance missing')
    const appearanceStream = appearance.get(PDFName.of('N'))
    const originalStream = originalAppearance.get(PDFName.of('N'))
    if (!(appearanceStream instanceof PDFRef) || !(originalStream instanceof PDFRef)) throw new Error('appearance streams missing')
    expect(appearanceStream.objectNumber).not.toBe(originalStream.objectNumber)
  })

  it('clones an inline annotation dictionary that paints a shared form', async () => {
    const pdf = await sharedFormWithWidgetPDF(true)
    const { document } = await extractFrontend(pdf, [1, 3])
    const { pdf: isolated } = await isolateSharedPageStreams(pdf, document)
    const original = await PDFDocument.load(pdf)
    const saved = await PDFDocument.load(isolated)
    const originalAnnotation = original.getPages()[0].node.Annots()!.get(0)
    if (!(originalAnnotation instanceof PDFDict)) throw new Error('fixture annotation is not inline')
    const sharedForm = originalAnnotation.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))
    if (!(sharedForm instanceof PDFRef)) throw new Error('fixture appearance stream missing')

    // The clone becomes a conforming indirect annotation with its own stream.
    const cloneRef = saved.getPages()[0].node.Annots()!.get(0)
    if (!(cloneRef instanceof PDFRef)) throw new Error('inline annotation was not isolated')
    const widget = saved.context.lookup(cloneRef, PDFDict)
    expect(widget.get(PDFName.of('T'))).toEqual(PDFName.of('SharedField'))
    const appearanceStream = widget.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'))
    if (!(appearanceStream instanceof PDFRef)) throw new Error('cloned appearance stream missing')
    expect(appearanceStream.objectNumber).not.toBe(sharedForm.objectNumber)
  })
})
