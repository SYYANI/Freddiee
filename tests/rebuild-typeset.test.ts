import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LatexError } from '../RebuildPDFKit/src/errors'
import { emptyMeasure } from '../RebuildPDFKit/src/geometry'
import { PageMarkup } from '../RebuildPDFKit/src/markup'
import { pageGlyphs, pageSize, withPDF } from '../RebuildPDFKit/src/pdf'
import { verifyTeXInstallation } from '../RebuildPDFKit/src/texCheck'
import { buildTeX } from '../RebuildPDFKit/src/texSource'
import { releaseColumnBreaks } from '../RebuildPDFKit/src/translation'
import { columnBottoms } from '../RebuildPDFKit/src/translationLayout'
import { XeLaTeXCompiler, compileTeX, typesetPage } from '../RebuildPDFKit/src/xelatex'
import { page, pageText, temporaryDirectory, testLayout, textLeft, xelatexPath } from './rebuild-support'

const compiler = new XeLaTeXCompiler(xelatexPath ?? 'xelatex')
const typography = { referenceSize: 10, referenceLeading: 12 }
const directories: Array<{ cleanup(): void }> = []
const scratch = (): string => {
  const directory = temporaryDirectory()
  directories.push(directory)
  return directory.path
}
afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup()
})

describe.skipIf(!xelatexPath)('RebuildPDFKit XeLaTeX typesetting', { timeout: 240_000 }, () => {
  it('finds every package and font a rebuild needs', async () => {
    await verifyTeXInstallation(compiler, scratch())
  })

  it('keeps the rest of the line after a bare percent in translated prose', async () => {
    const markup = PageMarkup.parse(page('最多超出 100%。其余文字保留。', { header: '20% header', footer: '30% footer' }))
    const result = await typesetPage({ directory: scratch(), markup, layout: testLayout, figures: [], lineMode: 'reflow', compiler })
    const text = (await pageText(result.pdf, 0)).replace(/\s/g, '')
    expect(text).toContain('100%。其余文字保留。')
    expect(text).toContain('20%header')
    expect(text).toContain('30%footer')
  })

  for (const mode of ['keep', 'reflow'] as const) {
    it(`compiles cent aliases and a column break after a caption (${mode})`, async () => {
      const body = '\\begin{multicols}{2}\n\\begin{center}\nLeft caption\n\\end{center}\n'
        + '\\columnbreak\n{\\small\nRight column\ncontinues\n}\n\\end{multicols}'
      const result = await typesetPage({
        directory: scratch(),
        markup: PageMarkup.parse(page(body, { footer: String.raw`\textcopyright 1984 75\cent\ \copyright 1984 75\cents`, columns: 2 })),
        layout: testLayout, figures: [], lineMode: mode, compiler
      })
      expect(result.pages).toBe(1)
      expect((await pageText(result.pdf, 0)).replace(/\s/g, '').split('75¢').length).toBe(3)
      expect(await textLeft(result.pdf, 'Right column')).toBeGreaterThan(testLayout.left + testLayout.textWidth / 2)
    })
  }

  it('compiles a page with vector text and math at the page size', async () => {
    const markup = PageMarkup.parse(page('Some \\textsc{Proof.} text with $\\overline{\\mathrm{Append}}(y,z,u)$\nand more', { header: 'Head \\hfill 735' }))
    const result = await typesetPage({ directory: scratch(), markup, layout: testLayout, figures: [], lineMode: 'keep', compiler })
    expect(result.pages).toBe(1)
    expect(result.scale).toBe(1)
    const size = await withPDF(new Uint8Array(await readFile(result.pdf)), async (document) => pageSize(await document.getPage(1)))
    expect(size).toEqual({ width: 300, height: 400 })
    expect(await pageText(result.pdf, 0)).toContain('Append')
  })

  it('shrinks an overflowing page uniformly', async () => {
    const body = Array.from({ length: 31 }, (_, index) => `Paragraph ${index} with enough words to fill one printed line.`).join('\n\n')
    const result = await typesetPage({ directory: scratch(), markup: PageMarkup.parse(page(body)), layout: testLayout, figures: [], lineMode: 'keep', compiler })
    expect(result.pages).toBe(1)
    expect(result.scale).toBeLessThan(1)
  })

  it('reduces small print and reports merged lines', async () => {
    const small = Array.from({ length: 3 }, () => `${'Words '.repeat(8)}in small type`).join('\n')
    const merged = 'Words '.repeat(40)
    const result = await typesetPage({
      directory: scratch(), markup: PageMarkup.parse(page(`Normal body line\n\n${small}\n\n${merged}`)), layout: testLayout, figures: [], lineMode: 'keep', compiler
    })
    const factors = new Set(result.paragraphSizes.factors)
    expect(factors.size).toBe(1)
    for (const factor of factors) expect(factor >= 0.75 && factor <= 0.9).toBe(true)
    expect(result.longLines.length).toBe(1)
    expect(result.longLines[0].startsWith('Words Words')).toBe(true)
  })

  it('reports the real height of a page spilling one line and shrinks it slightly', async () => {
    const body = Array.from({ length: 27 }, (_, index) => `Paragraph ${index} with words.`).join('\n\n')
    const markup = PageMarkup.parse(page(body, { footer: 'Footer line' }))
    const directory = scratch()
    const spilled = await compileTeX(directory, buildTeX({ markup, layout: testLayout, figures: [] }), compiler)
    expect(spilled.pages).toBe(2)
    expect(spilled.naturalHeight).toBeLessThan(spilled.textHeight * 1.1)
    const result = await typesetPage({ directory, markup, layout: testLayout, figures: [], lineMode: 'keep', compiler })
    expect(result.scale).toBeGreaterThan(0.93)
  })

  it('reduces the last body paragraph printed in smaller type', async () => {
    const small = Array.from({ length: 3 }, () => `${'Words '.repeat(8)}in small type`).join('\n')
    const result = await typesetPage({
      directory: scratch(), markup: PageMarkup.parse(page(`Normal body line\n\n${small}`, { footer: '1' })), layout: testLayout, figures: [], lineMode: 'keep', compiler
    })
    const factors = new Set(result.paragraphSizes.factors)
    expect(factors.size).toBe(1)
    for (const factor of factors) expect(factor >= 0.75 && factor <= 0.9).toBe(true)
    expect(result.scale).toBe(1)
  })

  it('scales an overwide display into its column or reports it', async () => {
    const display = (terms: number): string => `\\[ ${Array.from({ length: terms }, (_, index) => `a_{${index}}`).join(' + ')} \\]`
    const directory = scratch()
    const fitted = await typesetPage({
      directory, markup: PageMarkup.parse(page(`Text before\n${display(16)}\nText after`)), layout: testLayout, figures: [], lineMode: 'keep', compiler
    })
    expect(fitted.scale).toBe(1)
    expect(fitted.longLines).toEqual([])
    expect(await readFile(join(directory, 'main.tex'), 'utf8')).toContain(String.raw`\rebuilddisplay{875}{`)
    const far = await typesetPage({
      directory, markup: PageMarkup.parse(page(`Text before\n${display(24)}\nText after`)), layout: testLayout, figures: [], lineMode: 'keep', compiler
    })
    expect(far.longLines).toEqual([display(24)])
  })

  it('fits a kept listing wider than its column', async () => {
    const code = 'push(parse_stack, eot_entry); relation := precedence(x);'
    const body = `Text before\n\\begin{verbatim}\nbegin\n  ${code}\nend\n\\end{verbatim}\nText after`
    const result = await typesetPage({ directory: scratch(), markup: PageMarkup.parse(page(body)), layout: testLayout, figures: [], lineMode: 'keep', compiler })
    const factors = new Set(result.paragraphSizes.factors)
    expect(factors.size).toBe(1)
    for (const factor of factors) expect(factor >= 0.6 && factor < 0.75).toBe(true)
    expect(result.longLines).toEqual([])
  })

  it('reports an unsupported text character instead of dropping it', async () => {
    const tex = buildTeX({ markup: PageMarkup.parse(page('A \u2286 B')), layout: testLayout, figures: [] })
    const error = await compileTeX(scratch(), tex, compiler).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LatexError)
    expect((error as LatexError).message).toContain('math mode')
  })

  it('fits literal code to its column in reflow and keeps the heading on the right', async () => {
    const body = `\\begin{multicols}{2}\nLeft paragraph.\n\\begin{verbatim}\n    ${'code_'.repeat(6)}\n\\end{verbatim}\n\\columnbreak\n\\underline{Right heading}\n\\end{multicols}`
    const layout = { ...testLayout, pageWidth: 450, pageHeight: 650, left: 35, top: 40, textWidth: 380, textHeight: 560, columnGap: 18 }
    const result = await typesetPage({
      directory: scratch(), markup: PageMarkup.parse(page(body, { footer: '42', font: 'typewriter', columns: 2 })), layout, figures: [], lineMode: 'reflow', compiler
    })
    expect(result.overfull).toEqual([])
    expect(result.paragraphSizes.isEmpty).toBe(false)
    expect(result.scale).toBe(1)
    expect(await textLeft(result.pdf, 'Right heading')).toBeGreaterThan(layout.left + layout.textWidth / 2)
  })

  it('compiles Chinese typewriter columns with code, math and footer', async () => {
    const paragraph = '应用式语言使用递归方程定义函数，程序中的列表可以是有限的，也可以是无限的。'.repeat(3)
    const body = `\\begin{multicols}{2}\n${Array.from({ length: 3 }, () => paragraph).join('\n\n')}`
      + '\n\\begin{verbatim}\nf x = [x, x]\n\\end{verbatim}\n\\columnbreak\n\\texttt{f 3} 的计算结果是列表。\n\n'
      + String.raw`\[ x \in A \implies f(x) = x \]` + '\n\\end{multicols}'
    const layout = { ...testLayout, pageWidth: 450, pageHeight: 650, left: 35, top: 40, textWidth: 380, textHeight: 560, columnGap: 18 }
    const result = await typesetPage({
      directory: scratch(), markup: PageMarkup.parse(page(body, { footer: '42', font: 'typewriter', columns: 2 })), layout, figures: [], lineMode: 'reflow', compiler
    })
    expect(result.pages).toBe(1)
    expect(result.scale).toBe(1)
    expect(Math.max(0, ...result.overfull)).toBeLessThan(1)
    const text = (await pageText(result.pdf, 0)).replace(/\s/g, '')
    expect(text).toContain('应用式语言')
    expect(text).toContain('f3')
    expect(text).toContain('42')
  })

  it('balances a translation whose printed column break left it lopsided once the break is released', async () => {
    const prose = '中文译文比原文短，按原稿的分栏位置会让一栏几乎空白。'.repeat(6)
    const markup = PageMarkup.parse(page(`\\begin{multicols}{2}\n开头一句。\n\\columnbreak\n${prose}\n\\end{multicols}`, { columns: 2 }))
    const level = { ...emptyMeasure(300, 400), columnBottoms: [360, 362], pitch: 12 }
    const bottoms: number[][] = []
    for (const measure of [emptyMeasure(300, 400), level]) {
      const result = await typesetPage({
        directory: scratch(), markup: releaseColumnBreaks(markup, measure), layout: testLayout, figures: [], lineMode: 'reflow', compiler, typography
      })
      const found = await columnBottoms(result, testLayout)
      expect(found).toBeDefined()
      bottoms.push(found!)
    }
    expect(bottoms[0][1] - bottoms[0][0]).toBeGreaterThan(100)
    expect(Math.abs(bottoms[1][1] - bottoms[1][0])).toBeLessThan(13)
  })

  it('sets reflowed style groups and a ruled footnote in Chinese solid', async () => {
    const body = '\\textit{人类似乎能够学习新}\n\\textit{概念，而无需被显式编程。}'
    const footer = '\\rule{\\columnwidth}{0.4pt}\n{\\footnotesize 本研究部分得到美国国家科学基金会}\n'
      + '{\\footnotesize 资助。}\n\\rule{\\columnwidth}{0.4pt}\n{\\footnotesize 版权所有}'
    const result = await typesetPage({
      directory: scratch(), markup: PageMarkup.parse(page(body, { footer })), layout: testLayout, figures: [], lineMode: 'reflow', compiler, typography
    })
    // An indented full-width rule overflowed, and the footer was shrunk to make it fit.
    expect(result.overfull).toEqual([])
    expect(result.paragraphSizes.factors).toEqual([])
    const text = (await pageText(result.pdf, 0)).replace(/\s/g, '')
    expect(text).toContain('人类似乎能够学习新概念，而无需被显式编程。')
  })

  it('keeps a footnote closing the left column there while the translation flows past it', async () => {
    const prose = '中文译文比原文短，正文应当越过左栏脚注流入右栏。'.repeat(7)
    const note = '\\vspace{0.5\\baselineskip}\n{\\footnotesize\n\\noindent\\rule{\\linewidth}{0.4pt}\\\\\n'
      + '本研究部分得到基金会资助。\\\\\n\\rule{\\linewidth}{0.4pt}\\\\\n版权所有 1984\n}'
    const body = `\\begin{multicols}{2}\n${prose}有些显然似乎具有\n\n${note}\n\n\\columnbreak\n\n遗传上的成分。\n\\end{multicols}`
    const level = { ...emptyMeasure(300, 400), columnBottoms: [360, 362], pitch: 12 }
    const released = releaseColumnBreaks(PageMarkup.parse(page(body, { columns: 2 })), level)
    expect(released.body).toContain('有些显然似乎具有\n遗传上的成分')
    const result = await typesetPage({ directory: scratch(), markup: released, layout: testLayout, figures: [], lineMode: 'reflow', compiler, typography })
    const bottoms = await columnBottoms(result, testLayout)
    expect(bottoms).toBeDefined()
    const glyphs = await withPDF(new Uint8Array(await readFile(result.pdf)), async (document) => pageGlyphs(await document.getPage(1)))
    const visible = glyphs.filter((glyph) => glyph.text.trim())
    const start = visible.findIndex((glyph, index) => '版权所有'.split('').every((character, offset) => visible[index + offset]?.text === character))
    expect(start).toBeGreaterThanOrEqual(0)
    const copyright = visible.slice(start, start + 4)
    const gutter = testLayout.left + (testLayout.textWidth - testLayout.columnGap) / 2
    expect(Math.max(...copyright.map((glyph) => glyph.x1))).toBeLessThan(gutter)
    expect(Math.abs(bottoms![0] - bottoms![1])).toBeLessThan(24)
    expect(Math.abs(copyright[0].bottom - bottoms![0])).toBeLessThan(3)
  })
})
