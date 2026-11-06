// Figure text and untranslatable text keep their source glyphs, mirroring the
// Swift TypesettingTests / ILTranslatorTests added with
// reWriteBabelDoc docs/archives/figure-text-preservation.md.
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ILTranslator, type AsyncILTextTranslator, type ILTranslatorConfiguration } from '../BabelDocKit/src/translator'
import { Typesetting } from '../BabelDocKit/src/typesetting'
import type { ILDocument, ILPage, ILPdfCharacter, ILPdfParagraph, ILPdfStyle } from '../BabelDocKit/src/il'

const fontDirectory = join(resolve(__dirname, '..'), 'BabelDocKit', 'runtime', 'fonts')

class RecordingTranslator implements AsyncILTextTranslator {
  readonly maximumConcurrentTranslations = 1
  readonly requests: string[] = []
  constructor(private readonly prefix: string) {}
  formulaPlaceholder(id: number): string {
    return `<b${id}>`
  }
  async translate(text: string): Promise<string> {
    this.requests.push(text)
    return this.prefix + text
  }
}

function lineParagraph(text: string, label: string, y: number): ILPdfParagraph {
  const style: ILPdfStyle = { font_id: 'F1', font_size: 10 }
  return {
    box: { x: 10, y, x2: 10 + text.length * 5, y2: y + 10 },
    pdf_style: style,
    pdf_paragraph_composition: [{
      pdf_same_style_characters: {
        pdf_style: style,
        pdf_character: [...text].map((scalar, index): ILPdfCharacter => ({
          pdf_style: style,
          box: { x: 10 + index * 5, y, x2: 15 + index * 5, y2: y + 10 },
          pdf_character_id: scalar.charCodeAt(0),
          char_unicode: scalar
        }))
      }
    }],
    unicode: text,
    layout_label: label
  }
}

const configuration = (overrides: Partial<ILTranslatorConfiguration> = {}): ILTranslatorConfiguration => ({
  minimumTextLength: 5,
  documentTitle: null,
  glossary: null,
  semanticContexts: new Map(),
  ...overrides
})

describe('BabelDOC figure and untranslatable text', () => {
  it('does not send text without letters to the model', async () => {
    // Figure tick labels such as "10²⁰ 2" arrive as one line without letters.
    const ticks = lineParagraph('10 20 2', 'plain text', 0)
    const prose = lineParagraph('Weighted average', 'plain text', 40)
    const document: ILDocument = { page: [{ pdf_paragraph: [structuredClone(ticks), prose] }] }
    const translator = new RecordingTranslator('译:')

    await ILTranslator.processAsync(document, translator, configuration())

    expect(translator.requests).toEqual(['Weighted average'])
    expect(document.page?.[0].pdf_paragraph?.[0]).toEqual(ticks)
    expect(document.page?.[0].pdf_paragraph?.[1].unicode).toBe('译:Weighted average')
  })

  it('keeps the source paragraph when the reply repeats it', async () => {
    const label = lineParagraph('Multilingual results', 'plain text', 0)
    const document: ILDocument = { page: [{ pdf_paragraph: [structuredClone(label)] }] }

    const report = await ILTranslator.processAsync(document, new RecordingTranslator(''), configuration())

    expect(document.page?.[0].pdf_paragraph?.[0]).toEqual(label)
    expect(report.failedCount).toBe(0)
  })

  it('translates figure text only when enabled', async () => {
    const legend = lineParagraph('Top 8 / 256 experts', 'fallback_line', 60)
    const page = (): ILPage => ({
      page_layout: [{ box: { x: 0, y: 50, x2: 200, y2: 120 }, id: 1, class_name: 'figure' }],
      pdf_paragraph: [
        structuredClone(legend),
        lineParagraph('Stray line outside', 'fallback_line', 140),
        lineParagraph('Body text inside the figure box', 'plain text', 70)
      ]
    })

    const kept: ILDocument = { page: [page()] }
    const keeping = new RecordingTranslator('译:')
    await ILTranslator.processAsync(kept, keeping, configuration({ translatesFigureText: false }))
    expect(new Set(keeping.requests)).toEqual(new Set(['Stray line outside', 'Body text inside the figure box']))
    expect(kept.page?.[0].pdf_paragraph?.[0]).toEqual(legend)

    // Absent means translate, as Swift's ILTranslatorConfiguration defaults.
    const translated: ILDocument = { page: [page()] }
    await ILTranslator.processAsync(translated, new RecordingTranslator('译:'), configuration())
    expect(translated.page?.[0].pdf_paragraph?.[0].unicode).toBe('译:Top 8 / 256 experts')
  })

  it('keeps the geometry of untranslated text in fonts without a reusable xref', async () => {
    // Figure tick labels ("1.5", "10²⁰") drawn with a font that has no reusable
    // xref. Remapping them to the target font for a rebuilt stream must not
    // re-typeset them: a narrow box split "1.5" across two lines and one
    // baseline flattened the superscript.
    const body: ILPdfStyle = { font_id: 'F3', font_size: 10 }
    const script: ILPdfStyle = { font_id: 'F3', font_size: 6 }
    const glyph = (text: string, style: ILPdfStyle, x: number, y: number): ILPdfCharacter => {
      const size = style.font_size ?? 10
      const box = { x, y, x2: x + size * 0.5, y2: y + size }
      return { pdf_style: style, box, visual_bbox: { box }, pdf_character_id: text.charCodeAt(0), char_unicode: text }
    }
    const tick = [glyph('1', body, 10, 40), glyph('.', body, 15, 40), glyph('5', body, 17.5, 40)]
    const power = [glyph('1', body, 40, 40), glyph('0', body, 45, 40), glyph('2', script, 50, 46), glyph('0', script, 53, 46)]
    const paragraph = (characters: ILPdfCharacter[], text: string): ILPdfParagraph => ({
      box: { x: characters[0].box?.x, y: 40, x2: characters[characters.length - 1].box?.x2, y2: 52 },
      pdf_style: body,
      pdf_paragraph_composition: [{ pdf_same_style_characters: { pdf_style: body, pdf_character: structuredClone(characters) } }],
      unicode: text,
      layout_label: 'fallback_line'
    })
    const document: ILDocument = {
      page: [{
        cropbox: { box: { x: 0, y: 0, x2: 100, y2: 100 } },
        pdf_font: [{ name: 'SourceSerif4-Regular', font_id: 'F3', encoding_length: 1, bold: false, italic: false, serif: true }],
        pdf_paragraph: [paragraph(tick, '1.5'), paragraph(power, '1020')],
        page_number: 0
      }]
    }

    const report = await Typesetting.process(document, {
      targetLanguage: 'zh', targetFontDirectory: fontDirectory, preservedParagraphAddresses: new Set()
    })

    expect(report.pages[0].paragraphs.map((paragraph) => paragraph.isTypeset)).toEqual([false, false])
    for (const [index, source] of [tick, power].entries()) {
      const characters = (document.page?.[0].pdf_paragraph?.[index].pdf_paragraph_composition ?? [])
        .flatMap((composition) => composition.pdf_character ? [composition.pdf_character] : [])
      expect(characters.map((character) => character.box)).toEqual(source.map((character) => character.box))
      expect(characters.map((character) => character.char_unicode)).toEqual(source.map((character) => character.char_unicode))
      expect(characters.map((character) => character.pdf_style?.font_size)).toEqual(source.map((character) => character.pdf_style?.font_size))
      // Rebuilt streams still draw them through the target font.
      expect(characters.every((character) => character.pdf_style?.font_id === 'NotoSerif-Regular.ttf')).toBe(true)
    }
  })
})
