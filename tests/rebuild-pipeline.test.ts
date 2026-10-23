import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PageMarkup } from '../RebuildPDFKit/src/markup'
import { plainText } from '../RebuildPDFKit/src/model'
import { type RebuildConfiguration, type RebuildProgress, RebuildPipeline, readState } from '../RebuildPDFKit/src/pipeline'
import { pageSize, withPDF } from '../RebuildPDFKit/src/pdf'
import { simplifiedChinese } from '../RebuildPDFKit/src/translation'
import { XeLaTeXCompiler } from '../RebuildPDFKit/src/xelatex'
import { Replies, ScriptedModel, makeSourcePDF, noText, page, pageCount, pageText, temporaryDirectory, xelatexPath } from './rebuild-support'

const compiler = new XeLaTeXCompiler(xelatexPath ?? 'xelatex')
const directories: Array<{ cleanup(): void }> = []
const root = (): string => {
  const directory = temporaryDirectory()
  directories.push(directory)
  return directory.path
}
afterEach(() => {
  for (const directory of directories.splice(0)) directory.cleanup()
})

function pipeline(transcriber: ScriptedModel, configuration: Partial<RebuildConfiguration>, translator?: ScriptedModel): RebuildPipeline {
  return new RebuildPipeline({ transcriber, translator, recognizer: noText, compiler, configuration })
}

/** The source page from a translation request, as a translator that changes only words would return it. */
function echo(request: { messages: Array<{ parts: Array<{ type: string; text?: string }> }> }, index: number): string {
  const text = plainText(request.messages[index] as never)!
  return text.slice(text.indexOf('\n') + 1)
}

describe.skipIf(!xelatexPath)('RebuildPDFKit pipeline', { timeout: 300_000 }, () => {
  it('transcribes, proofreads, caches and keeps hand edits', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['scanned words', 'scanned words'])
    const rejectedFirst = new Replies([page(String.raw`\input{x}`)])
    const transcriber = new ScriptedModel((request) => {
      if (request.label.startsWith('review')) return '<changes></changes><unchanged/>'
      return rejectedFirst.next() || page('Rebuilt words on the page')
    })
    const configuration = { dpi: 100, maximumConcurrentPages: 1, pages: [2] }
    const output = join(directory, 'out.pdf')
    const artifacts = join(directory, 'work')
    const result = await pipeline(transcriber, configuration).run(source, output, artifacts)
    expect(transcriber.labels).toEqual(['typeset-page-0002', 'typeset-page-0002', 'review-page-0002'])
    expect(plainText(transcriber.requests[1].messages.at(-1)!)).toContain('could not be used')
    expect(result.rebuiltPages).toEqual([2])
    expect(await pageCount(output)).toBe(2)
    expect(await pageText(output, 0)).toContain('scanned words')
    expect(await pageText(output, 1)).toContain('Rebuilt words')

    // Nothing changed: every answer comes from the checkpoints.
    transcriber.reset()
    await pipeline(transcriber, configuration).run(source, output, artifacts)
    expect(transcriber.labels).toEqual([])

    // Another model invalidates the transcription.
    const other = new ScriptedModel((request) => request.label.startsWith('review') ? '<changes></changes><unchanged/>' : page('Other model words'), 'other-model')
    await pipeline(other, configuration).run(source, output, artifacts)
    expect(other.labels).toEqual(['typeset-page-0002', 'review-page-0002'])

    // A hand-corrected page wins and is never sent to the model.
    await writeFile(join(artifacts, 'typeset', 'page-0002.page.tex'), page('Hand corrected words'))
    other.reset()
    await pipeline(other, configuration).run(source, output, artifacts)
    expect(other.labels).toEqual([])
    expect(await pageText(output, 1)).toContain('Hand corrected')
  })

  it('sends merged lines back and rejects a proofreading pass that merges lines', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, [''])
    const merged = page('Words '.repeat(60))
    const fine = page(Array.from({ length: 10 }, () => 'Words '.repeat(6)).join('\n'))
    const replies = new Replies([merged, fine, `<changes>joined lines</changes>${merged}`, merged, merged])
    const transcriber = new ScriptedModel(() => replies.next())
    const artifacts = join(directory, 'work')
    await pipeline(transcriber, { dpi: 100, maximumConcurrentPages: 1 }).run(source, join(directory, 'out.pdf'), artifacts)
    expect(plainText(transcriber.requests[1].messages.at(-1)!)).toContain('far wider than any printed line')
    const state = await readState(join(artifacts, 'typeset', 'page-0001.json'))
    expect(state?.final).toBe(PageMarkup.parse(fine).serialize())
    expect(state?.changes.at(-1)).toContain('校对结果被拒绝')
  })

  it('typesets the validated draft after a failed review request and retries it on the next run', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['scanned words'])
    const outage = new Replies(['down'])
    const transcriber = new ScriptedModel((request) => {
      if (!request.label.startsWith('review')) return page('Rebuilt words on the page')
      if (outage.next() === 'down') throw new Error('The network connection was lost.')
      return '<changes></changes><unchanged/>'
    })
    const configuration = { dpi: 100, maximumConcurrentPages: 1 }
    const output = join(directory, 'out.pdf')
    const artifacts = join(directory, 'work')
    const first = await pipeline(transcriber, configuration).run(source, output, artifacts)
    expect(first.rebuiltPages).toEqual([1])
    expect(first.fallbacks.size).toBe(0)
    expect(first.reports[0].review_failure).toContain('校对请求失败')
    expect(await pageText(output, 0)).toContain('Rebuilt words')

    transcriber.reset()
    const retried = await pipeline(transcriber, configuration).run(source, output, artifacts)
    expect(transcriber.labels).toEqual(['review-page-0001'])
    expect(retried.reports[0].review_failure).toBeUndefined()
  })

  it('translates from the cached transcription, keeps the page and respects edits', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['Original source words'])
    const artifacts = join(directory, 'work')
    const transcriber = new ScriptedModel(() => page('Source words $x$.'))
    await pipeline(transcriber, { dpi: 100, reviewRounds: 0 }).run(source, join(directory, 'english.pdf'), artifacts)
    const sourceFiles = (await readdir(join(artifacts, 'typeset'))).filter((file) => file.startsWith('page-'))
    const sourceBytes = await Promise.all(sourceFiles.map((file) => readFile(join(artifacts, 'typeset', file))))
    transcriber.reset()

    const translator = new ScriptedModel((request) => echo(request, request.messages.length - 1).replaceAll('Source words', '原文翻译'), 'translator')
    const chinese = join(directory, 'chinese.pdf')
    const transcription = join(directory, 'transcription.pdf')
    const configuration: Partial<RebuildConfiguration> = { dpi: 100, reviewRounds: 0, translation: simplifiedChinese }
    const result = await pipeline(transcriber, configuration, translator).run(source, chinese, artifacts, transcription)
    expect(transcriber.labels).toEqual([])
    expect(translator.labels).toEqual(['translate-zh-page-0001'])
    expect(translator.requests[0].messages.every((message) => plainText(message) !== undefined)).toBe(true)
    expect(result.usage.total_tokens).toBe(10)
    expect(result.manifest).toBe(join(artifacts, 'translations', 'zh', 'manifest.json'))
    expect(JSON.parse(await readFile(result.manifest, 'utf8')).line_breaks).toBe('reflow')
    expect(await Promise.all(sourceFiles.map((file) => readFile(join(artifacts, 'typeset', file))))).toEqual(sourceBytes)
    expect(await pageCount(chinese)).toBe(1)
    expect(await withPDF(new Uint8Array(await readFile(chinese)), async (document) => pageSize(await document.getPage(1)))).toEqual({ width: 300, height: 400 })
    expect((await pageText(chinese, 0)).replace(/\s/g, '')).toContain('原文翻译')
    expect(result.sourceOutput).toBe(transcription)
    expect(result.sourceRebuiltPages).toEqual([1])
    expect(await pageCount(transcription)).toBe(1)
    expect(await pageText(transcription, 0)).toContain('Source words')

    const refusing = new ScriptedModel(() => {
      throw new Error('not expected')
    }, 'translator')
    await pipeline(transcriber, configuration, refusing).run(source, chinese, artifacts)
    const edited = join(artifacts, 'translations', 'zh', 'typeset', 'page-0001.page.tex')
    await writeFile(edited, (await readFile(edited, 'utf8')).replace('原文翻译', '手工校正'))
    await pipeline(transcriber, configuration, refusing).run(source, chinese, artifacts)
    expect(refusing.labels).toEqual([])
    expect((await pageText(chinese, 0)).replace(/\s/g, '')).toContain('手工校正')

    // force redoes only the translation; the transcription stays cached.
    translator.reset()
    await pipeline(transcriber, { ...configuration, force: true }, translator).run(source, chinese, artifacts)
    expect(translator.labels).toEqual(['translate-zh-page-0001'])
    expect(transcriber.labels).toEqual([])
  })

  for (const failure of ['invalid-markup', 'overflow']) {
    it(`keeps the validated page for translation after an unusable review and checkpoints the rejection (${failure})`, async () => {
      const directory = root()
      const input = join(directory, 'source.pdf')
      await makeSourcePDF(input, ['scanned words'])
      const draft = page('Valid source words $x$.')
      const invalid = failure === 'invalid-markup' ? String.raw`\input{x}` : Array.from({ length: 200 }, () => 'Duplicated figure text.').join('\n\n')
      const transcriber = new ScriptedModel((request) => request.label.startsWith('review') ? page(invalid) : draft)
      const translator = new ScriptedModel((request) => echo(request, 1).replaceAll('Valid source words', '有效原文的译文'), 'translator')
      const output = join(directory, 'translated.pdf')
      const transcription = join(directory, 'transcription.pdf')
      const artifacts = join(directory, 'work')
      const configuration: Partial<RebuildConfiguration> = { dpi: 100, maximumConcurrentPages: 1, translation: simplifiedChinese }
      const result = await pipeline(transcriber, configuration, translator).run(input, output, artifacts, transcription)
      expect(result.fallbacks.size).toBe(0)
      expect(result.rebuiltPages).toEqual([1])
      expect(result.sourceRebuiltPages).toEqual([1])
      expect(await pageCount(output)).toBe(1)
      expect((await pageText(output, 0)).replace(/\s/g, '')).toContain('有效原文的译文')
      expect(await pageText(transcription, 0)).toContain('Valid source words')
      expect(transcriber.labels).toEqual(['typeset-page-0001', 'review-page-0001', 'review-page-0001', 'review-page-0001'])
      const state = await readState(join(artifacts, 'typeset', 'page-0001.json'))
      expect(state?.final).toBe(PageMarkup.parse(draft).serialize())
      expect(state?.rounds).toBe(1)
      expect(state?.usage.total_tokens).toBe(40)
      expect(state?.changes.at(-1)).toContain('校对结果被拒绝')
      expect(state?.changes.at(-1)).not.toContain('无需修改')

      transcriber.reset()
      translator.reset()
      await pipeline(transcriber, configuration, translator).run(input, output, artifacts, transcription)
      expect(transcriber.labels).toEqual([])
      expect(translator.labels).toEqual([])
    })
  }

  it('keeps the scan in the translation for a page whose translation fails, but typesets its transcription', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['first page words', 'second page words'])
    const transcriber = new ScriptedModel((request) => page(request.label === 'typeset-page-0001' ? 'First rebuilt page $x$.' : 'Second rebuilt page $y$.'))
    // Page 2's answers drop the protected formula, so its translation never validates.
    const translator = new ScriptedModel((request) => {
      const answer = echo(request, 1).replaceAll('rebuilt page', '重建页')
      return request.label === 'translate-zh-page-0002' ? answer.replace('REBUILDPDFPROTECTED0000TOKEN', '') : answer
    }, 'translator')
    const output = join(directory, 'chinese.pdf')
    const transcription = join(directory, 'transcription.pdf')
    const events: RebuildProgress[] = []
    const configuration: Partial<RebuildConfiguration> = { dpi: 100, reviewRounds: 0, translation: simplifiedChinese }
    const result = await pipeline(transcriber, configuration, translator).run(source, output, join(directory, 'work'), transcription, (event) => events.push(event))
    expect(result.rebuiltPages).toEqual([1])
    expect(result.fallbacks.get(2)?.startsWith('translating:')).toBe(true)
    expect(result.sourceRebuiltPages).toEqual([1, 2])
    expect(await pageText(output, 1)).toContain('second page words')
    expect(await pageText(transcription, 1)).toContain('Second rebuilt page')
    expect(translator.labels.filter((label) => label === 'translate-zh-page-0002').length).toBe(3)
    expect(events.at(-1)?.completedSteps).toBe(6)
    expect(events.at(-1)?.totalSteps).toBe(6)

    // Running again asks for the failed translation again; the finished page is reused.
    transcriber.reset()
    translator.reset()
    await pipeline(transcriber, configuration, translator).run(source, output, join(directory, 'work'), transcription)
    expect(transcriber.labels).toEqual([])
    expect(translator.labels).toEqual(['translate-zh-page-0002', 'translate-zh-page-0002', 'translate-zh-page-0002'])
  })

  it('keeps and reports the original page that the model cannot transcribe', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['first page words', 'second page words'])
    const transcriber = new ScriptedModel((request) => request.label === 'typeset-page-0002' ? page(String.raw`\input{x}`) : page('Rebuilt first page'))
    const output = join(directory, 'out.pdf')
    const result = await pipeline(transcriber, { dpi: 100, reviewRounds: 0 }).run(source, output, join(directory, 'work'))
    expect(result.rebuiltPages).toEqual([1])
    expect(result.fallbacks.get(2)?.startsWith('transcribing:')).toBe(true)
    expect(await pageText(output, 0)).toContain('Rebuilt first page')
    expect(await pageText(output, 1)).toContain('second page words')
    expect(transcriber.labels.filter((label) => label === 'typeset-page-0002').length).toBe(3)

    // Running again asks the model again instead of replaying the saved answers that failed.
    transcriber.reset()
    const again = await pipeline(transcriber, { dpi: 100, reviewRounds: 0 }).run(source, output, join(directory, 'work'))
    expect(again.fallbacks.get(2)?.startsWith('transcribing:')).toBe(true)
    expect(transcriber.labels).toEqual(['typeset-page-0002', 'typeset-page-0002', 'typeset-page-0002'])
  })

  it('counts every page step in its progress', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['a', 'b'])
    const transcriber = new ScriptedModel((request) => request.label.startsWith('review') ? '<changes></changes><unchanged/>' : page('Rebuilt'))
    const translator = new ScriptedModel((request) => echo(request, request.messages.length - 1).replaceAll('Rebuilt', '重建'), 'translator')
    const events: RebuildProgress[] = []
    await pipeline(transcriber, { dpi: 100, translation: simplifiedChinese }, translator)
      .run(source, join(directory, 'out.pdf'), join(directory, 'work'), undefined, (event) => events.push(event))
    expect(events.at(-1)?.stage).toBe('assembling')
    expect(events.at(-1)?.completedSteps).toBe(8)
    expect(events.every((event) => event.totalSteps === 8)).toBe(true)
    expect(new Set(events.map((event) => event.stage))).toEqual(new Set(['rendering', 'transcribing', 'reviewing', 'translating', 'typesetting', 'assembling']))
  })

  it('stops when the run is cancelled', async () => {
    const directory = root()
    const source = join(directory, 'source.pdf')
    await makeSourcePDF(source, ['a'])
    const controller = new AbortController()
    const transcriber = new ScriptedModel(() => {
      controller.abort()
      return page('Rebuilt')
    })
    const run = new RebuildPipeline({ transcriber, recognizer: noText, compiler, configuration: { dpi: 100 }, signal: controller.signal })
      .run(source, join(directory, 'out.pdf'), join(directory, 'work'))
    await expect(run).rejects.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })
})
