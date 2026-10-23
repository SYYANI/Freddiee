import { readFileSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RGBImage } from '../RebuildPDFKit/src/bitmap'
import { coverageWarnings } from '../RebuildPDFKit/src/coverage'
import { LatexError, MarkupError, RebuildError } from '../RebuildPDFKit/src/errors'
import { validateFigureRegions } from '../RebuildPDFKit/src/figures'
import type { OcrLine } from '../RebuildPDFKit/src/geometry'
import { PageMarkup } from '../RebuildPDFKit/src/markup'
import { CheckpointedModel, type RebuildCompletionRequest } from '../RebuildPDFKit/src/model'
import { RebuildPipeline } from '../RebuildPDFKit/src/pipeline'
import { verifyTeXInstallation } from '../RebuildPDFKit/src/texCheck'
import { tesseractLines } from '../RebuildPDFKit/src/textRecognition'
import { protectMarkup, restoreTranslation } from '../RebuildPDFKit/src/translation'
import { page, temporaryDirectory } from './rebuild-support'

function thrown(body: () => unknown): Error | undefined {
  try {
    body()
  } catch (error) {
    return error as Error
  }
  return undefined
}

describe('RebuildPDFKit markup rules', () => {
  it('prints bare percent signs while keeping escapes and verbatim', () => {
    const markup = PageMarkup.parse(page(
      '100% of costs. Already 50\\%.\n\\\\% after a line break.\n\\begin{verbatim}\n% literal code \\%\n\\end{verbatim}',
      { header: '20% header', footer: '30% footer' }
    ))
    expect(markup.header).toBe(String.raw`20\% header`)
    expect(markup.footer).toBe(String.raw`30\% footer`)
    expect(markup.body).toContain(String.raw`100\% of costs. Already 50\%.`)
    expect(markup.body).toContain(String.raw`\\\% after a line break.`)
    expect(markup.body).toContain('\\begin{verbatim}\n% literal code \\%\n\\end{verbatim}')
    expect(PageMarkup.parse(markup.serialize()).equals(markup)).toBe(true)
  })

  it('removes plain TeX comments instead of printing them', () => {
    const markup = PageMarkup.parse(page(
      '\\begin{center}%\nTitle\n\\end{center}%\n% a note to ourselves\n'
        + 'Left words\n\\columnbreak % end of left column\n'
        + 'Rate \\verb|printf("%d")| and \\textbf{50}% of all.\n  % indented note\nLast'
    ))
    expect(markup.body).toBe('\\begin{center}\nTitle\n\\end{center}\n'
      + 'Left words\n\\columnbreak\n'
      + 'Rate \\verb|printf("%d")| and \\textbf{50}\\% of all.\nLast')
    expect(PageMarkup.parse(markup.serialize()).equals(markup)).toBe(true)
  })

  it('round-trips sections, figures and notes and drops unplaced figures', () => {
    const text = `noise\n${page(String.raw`Text \rebuildfigure{f1}`, { header: String.raw`\textit{Head} \hfill 7`, footer: '8', figures: 'f1: 100 200 900 400' })}`
      .replace('<notes>\n', '<notes>\nline 3 smudged\n')
    const markup = PageMarkup.parse(text)
    expect(markup.header).toBe(String.raw`\textit{Head} \hfill 7`)
    expect(markup.figures.get('f1')).toEqual({ x0: 100, y0: 200, x1: 900, y1: 400 })
    expect(markup.notes).toEqual(['line 3 smudged'])
    expect(PageMarkup.parse(markup.serialize()).equals(markup)).toBe(true)
    expect(PageMarkup.parse(page('Text', { figures: 'f1: 1 2 3 4' })).figures.isEmpty).toBe(true)
  })

  it('rejects file access, definitions and unbalanced structure', () => {
    for (const body of [String.raw`\input{/etc/passwd}`, String.raw`\newcommand{\x}{unsafe}`, String.raw`\begin{itemize}\item x\end{itemize}`, '{open', '\\[ x', 'a ^^41 b', '$$x$$']) {
      expect(thrown(() => PageMarkup.parse(page(body))), body).toBeInstanceOf(MarkupError)
    }
  })

  it('keeps paragraph count and source indentation in a translation', () => {
    const source = PageMarkup.parse(page('\\noindent First.\n\nSecond.'))
    const { text, protected: spans } = protectMarkup(source)
    const target = restoreTranslation(text.replace('\\noindent First.', '第一段。').replace('Second.', '\\noindent 第二段。'), spans, source)
    expect(target.body).toBe('\\noindent 第一段。\n\n第二段。')
    expect(thrown(() => restoreTranslation(text.replace('\n\n', '\n'), spans, source))).toBeInstanceOf(MarkupError)
  })

  it('rejects missing, duplicated and moved math', () => {
    const source = PageMarkup.parse(page('Text $x$ and $y$.\n\nMore $z$.'))
    const { text, protected: spans } = protectMarkup(source)
    const x = 'REBUILDPDFPROTECTED0000TOKEN'
    const z = 'REBUILDPDFPROTECTED0002TOKEN'
    for (const [invalid, message] of [
      [text.replace(x, ''), `missing ${x}`],
      [text.replace(x, x + x), `repeated ${x}`],
      [text.replace(x, 'REBUILDPDFPROTECTED0009TOKEN'), `missing ${x}; unknown`],
      [text.replace(x, '').replace('<header>', `<header>${x}`), 'in header'],
      [text.replace(x, '').replace(z, `${z} ${x}`), 'out of paragraph 1 in body']
    ]) {
      const error = thrown(() => restoreTranslation(invalid, spans, source))
      expect(error).toBeInstanceOf(MarkupError)
      expect(error!.message).toContain(message)
    }
  })

  it('does not read a line break with extra space as display math', () => {
    PageMarkup.parse(page('begin\n\\\\[0.3\\baselineskip]\nend'))
    expect(thrown(() => PageMarkup.parse(page('\\[ x')))).toBeInstanceOf(MarkupError)
    const source = PageMarkup.parse(page('\\textbf{begin} $v$\n\\\\[0.3\\baselineskip]\nend\n\n\\[ x \\]'))
    const { text, protected: spans } = protectMarkup(source)
    expect(spans).toEqual(['$v$', '\\[ x \\]'])
    expect(text).toContain('\\\\[0.3\\baselineskip]')
  })

  it('lets math move within its paragraph to follow Chinese word order', () => {
    const source = PageMarkup.parse(page('Then $F(w) = 1$ for all $w$ that agree with $v$.\n\nMore $z$.'))
    const { text, protected: spans } = protectMarkup(source)
    const [a, b, c] = ['REBUILDPDFPROTECTED0000TOKEN', 'REBUILDPDFPROTECTED0001TOKEN', 'REBUILDPDFPROTECTED0002TOKEN']
    const raw = text.replace(`Then ${a} for all ${b} that agree with ${c}.`, `对所有与 ${c} 一致的 ${b}，都有 ${a}。`)
    expect(restoreTranslation(raw, spans, source).body).toBe('对所有与 $v$ 一致的 $w$，都有 $F(w) = 1$。\n\nMore $z$.')
  })
})

describe('RebuildPDFKit illustrations', () => {
  const stacked = RGBImage.decode(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'rebuild-pdf', 'images', 'stacked.png'))))

  it('requires a complete crop for a numbered framed listing', async () => {
    const image = await stacked
    const lines: OcrLine[] = [{ id: 'caption', left: 820, top: 856, right: 920, bottom: 867, text: 'FIGURE 2.2.', confidence: 95 }]
    const missing = PageMarkup.parse(page('\\begin{verbatim}\ncode\n\\end{verbatim}\nFIGURE 2.2.'))
    expect(thrown(() => validateFigureRegions(missing, image, lines))).toBeInstanceOf(LatexError)
    validateFigureRegions(PageMarkup.parse(page(String.raw`\rebuildfigure{f1}`, { figures: 'f1: 540 390 929 530' })), image, lines)
    validateFigureRegions(missing, image, [])
  })

  it('accepts cropped text during review while still rejecting lost body text', () => {
    const code = 'The string represents the complete body of this program.'
    const body = 'The compiler reproduces its source using this definition.'
    const before = PageMarkup.parse(page(`${code}\n\n${body}`))
    const after = PageMarkup.parse(page(`\\rebuildfigure{f1}\n\n${body}`, { figures: 'f1: 100 100 500 500' }))
    const lines: OcrLine[] = [
      { id: 'code', left: 110, top: 110, right: 490, bottom: 140, text: code, confidence: 95 },
      { id: 'body', left: 110, top: 600, right: 890, bottom: 630, text: body, confidence: 95 }
    ]
    const size = { width: 1000, height: 1000 }
    expect(coverageWarnings(after, lines, size)).toEqual([])
    expect(RebuildPipeline.reviewRegression(before, after, lines, size)).toBe('')
    after.body = String.raw`\rebuildfigure{f1}`
    expect(RebuildPipeline.reviewRegression(before, after, lines, size)).toContain('正文词数')
  })
})

describe('RebuildPDFKit checkpointed model', () => {
  it('asks again with twice the budget after a truncated answer, then replays it from disk', async () => {
    const directory = temporaryDirectory()
    try {
      const budgets: number[] = []
      const client = {
        identity: 'truncating',
        complete: async (request: RebuildCompletionRequest) => {
          budgets.push(request.maxTokens)
          return { text: 'answer', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 1 }, finishReason: request.maxTokens < 65_536 ? 'length' as const : 'stop' as const }
        }
      }
      const model = new CheckpointedModel(client, directory.path)
      const messages = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }, { type: 'jpeg' as const, data: new Uint8Array([1, 2, 3]) }] }]
      const first = await model.chat('typeset-page-0001', messages)
      expect(first.text).toBe('answer')
      expect(first.usage.total_tokens).toBe(2)
      expect(budgets).toEqual([32_768, 65_536])
      await model.chat('typeset-page-0001', messages)
      expect(budgets).toEqual([32_768, 65_536])
      const files = (await readdir(directory.path)).filter((file) => !file.endsWith('.tmp'))
      expect(files.length).toBe(2)
      expect(files.every((file) => file.startsWith('typeset-page-0001-'))).toBe(true)
    } finally {
      directory.cleanup()
    }
  })

  it('fails an answer cut off by something other than the budget', async () => {
    const model = new CheckpointedModel({
      identity: 'filtered',
      complete: async () => ({ text: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, finishReason: 'other' })
    }, undefined)
    const error = await model.chat('x', []).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RebuildError)
    expect((error as RebuildError).reason).toEqual({ kind: 'incompleteModelOutput', label: 'x', finishReason: 'other' })
  })
})

describe('RebuildPDFKit TeX installation check', () => {
  it('names a missing package', async () => {
    const directory = temporaryDirectory()
    try {
      const compiler = {
        compile: async (path: string) => {
          const log = "(./main.tex\n! LaTeX Error: File `newtxtext.sty' not found.\n"
          await writeFile(join(path, 'main.log'), log)
          return { status: 1, output: log }
        }
      }
      const error = await verifyTeXInstallation(compiler, directory.path).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LatexError)
      expect((error as LatexError).message).toBe("LaTeX error: ! LaTeX Error: File `newtxtext.sty' not found.")
    } finally {
      directory.cleanup()
    }
  })
})

describe('RebuildPDFKit Tesseract lines', () => {
  it('groups words into lines, splits at wide gaps and averages confidence', () => {
    const word = (text: string, x0: number, x1: number, confidence: number) => ({ text, confidence, bbox: { x0, y0: 100, x1, y1: 120 } })
    const lines = tesseractLines([
      [word('Hello', 10, 60, 90), word('world', 70, 120, 95.25)],
      [word('left', 10, 50, 80), word('far', 400, 440, -1)]
    ])
    expect(lines).toEqual([
      { id: 'l0001', left: 10, top: 100, right: 120, bottom: 120, text: 'Hello world', confidence: 92.6 },
      { id: 'l0002', left: 10, top: 100, right: 50, bottom: 120, text: 'left', confidence: 80 },
      { id: 'l0003', left: 400, top: 100, right: 440, bottom: 120, text: 'far', confidence: 0 }
    ])
  })
})
